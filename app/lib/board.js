/**
 * Kanban board: pure logic (no DB, no fs). Columns, the manual status
 * transition table, human-input derivation, filters, display redaction,
 * Europe/Zurich time formatting. Rendering lives in board-view.js.
 */
import { redactIdentifyingDetails } from "./redact.js";
import { pushRetryJob } from "./results.js";

// ------------------------------------------------------------------ columns

/** Board columns in lifecycle order. Done = resolved + closed (tag on card). */
export const COLUMNS = [
  { key: "open", label: "Open", statuses: ["open"] },
  { key: "triaged", label: "Triaged", statuses: ["triaged"] },
  { key: "fixing", label: "Fixing", statuses: ["fixing"], workerOwned: true },
  { key: "testing", label: "Testing", statuses: ["testing"], workerOwned: true },
  { key: "needs_human", label: "Needs human", statuses: ["needs_human"] },
  { key: "pr_opened", label: "PR open", statuses: ["pr_opened"] },
  { key: "done", label: "Done", statuses: ["resolved", "closed"] },
];

export const STATUS_LABELS = {
  open: "Open",
  triaged: "Triaged",
  fixing: "Fixing",
  testing: "Testing",
  needs_human: "Needs human",
  pr_opened: "PR open",
  resolved: "Resolved",
  closed: "Closed",
};

export function columnForStatus(status) {
  const c = COLUMNS.find((col) => col.statuses.includes(status));
  return c ? c.key : "open";
}

// -------------------------------------------------------------- transitions

/** Statuses only the host worker (via Start fix / results) may set. */
export const WORKER_OWNED = ["fixing", "testing"];

/**
 * Manual (admin board / form) status changes: from → allowed targets.
 * Nothing may be moved INTO fixing/testing by hand (Start fix does that).
 */
export const TRANSITIONS = Object.freeze({
  open: ["triaged", "needs_human", "resolved", "closed"],
  triaged: ["open", "needs_human", "resolved", "closed"],
  // Only to unstick a job whose worker died; the worker otherwise owns it.
  fixing: ["needs_human"],
  // Lab test skipped on the host: Damo tests manually, then PR open.
  testing: ["pr_opened", "needs_human", "triaged", "resolved", "closed"],
  needs_human: ["triaged", "resolved", "closed"],
  pr_opened: ["triaged", "needs_human", "resolved", "closed"],
  resolved: ["open", "triaged", "closed"],
  closed: ["open", "triaged", "resolved"],
});

/**
 * @returns {{ ok: boolean, code?: string, message?: string }}
 */
export function checkTransition(from, to) {
  if (!Object.hasOwn(TRANSITIONS, to)) {
    return { ok: false, code: "invalid_status", message: `Unknown status "${String(to)}".` };
  }
  if (!Object.hasOwn(TRANSITIONS, from)) {
    return { ok: false, code: "invalid_status", message: `Unknown current status "${String(from)}".` };
  }
  if (from === to) return { ok: true };
  if (WORKER_OWNED.includes(to)) {
    return {
      ok: false,
      code: "worker_owned",
      message: `${STATUS_LABELS[to]} is set by the host worker; use Start fix instead of moving the card.`,
    };
  }
  if (!TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      code: "invalid_transition",
      message: `Can't move from ${STATUS_LABELS[from]} to ${STATUS_LABELS[to]}. Allowed: ${TRANSITIONS[from].map((s) => STATUS_LABELS[s]).join(", ")}.`,
    };
  }
  return { ok: true };
}

// ------------------------------------------------------------ human input

export const ACTIONS = {
  start_triage: "Start triage",
  start_fix: "Start fix",
  retry_push: "Retry push",
  retry_lab: "Retry lab test",
  approve_lab: "Approve lab test",
  skip_lab: "Skip lab (NOT lab-tested)",
  open_compare: "Open compare link",
  open_pr: "Open PR on GitHub",
  create_pr: "Open the PR now",
  retry_open_pr: "Retry open PR",
  adopt_pr: "Adopt PR",
  mark_config_error: "Mark config error & close",
  mark_resolved: "Mark resolved",
  close: "Close",
};

export const TRIAGE_VERDICTS = ["code_fix", "config_error", "not_actionable", "uncertain"];
/** Below this triage confidence the verdict is treated as uncertain. */
export const LOW_CONFIDENCE = 0.6;

function metaOf(e) {
  if (!e) return null;
  if (e.meta !== undefined) return e.meta;
  try {
    return e.meta_json ? JSON.parse(e.meta_json) : null;
  } catch {
    return null;
  }
}

function latestEvent(events, kinds) {
  let best = null;
  for (const e of events || []) {
    if (!kinds.includes(e.kind)) continue;
    if (!best || Number(e.id) > Number(best.id)) best = e;
  }
  return best ? { ...best, meta: metaOf(best) } : null;
}

/** 0..1, or null. Accepts numbers, "85%", 85, "high|medium|low". */
export function normalizeConfidence(v) {
  if (v == null || v === "") return null;
  const words = { high: 0.9, medium: 0.6, med: 0.6, low: 0.3 };
  if (typeof v === "string" && Object.hasOwn(words, v.trim().toLowerCase())) return words[v.trim().toLowerCase()];
  const n = Number(String(v).replace(/%$/, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  const x = n > 1 ? n / 100 : n;
  return x > 1 ? 1 : x;
}

/**
 * Read a triage_result payload. New contract: verdict + confidence.
 * Old results (class + fixable only) are mapped:
 *   human_config → config_error, software+fixable → code_fix,
 *   software+!fixable → not_actionable, unknown/missing → uncertain.
 * @returns {null | { verdict: string, confidence: number|null, legacy: boolean, lowConfidence: boolean, failed: boolean }}
 */
export function interpretTriage(meta) {
  if (!meta || typeof meta !== "object") return null;
  if (meta.status === "triage_failed") {
    return { verdict: "failed", confidence: null, legacy: false, lowConfidence: false, failed: true };
  }
  const confidence = normalizeConfidence(meta.confidence);
  let verdict = TRIAGE_VERDICTS.includes(meta.verdict) ? meta.verdict : null;
  const legacy = !verdict;
  if (!verdict) {
    if (meta.class === "human_config") verdict = "config_error";
    else if (meta.class === "software" && meta.fixable === true) verdict = "code_fix";
    else if (meta.class === "software" && meta.fixable === false) verdict = "not_actionable";
    else verdict = "uncertain";
  }
  const lowConfidence = confidence != null && confidence < LOW_CONFIDENCE;
  if (lowConfidence) verdict = "uncertain";
  return { verdict, confidence, legacy, lowConfidence, failed: false };
}

function reason(code, label, actions = [], detail) {
  const out = { code, label, action: actions[0] || null, actions };
  if (detail) out.detail = String(detail);
  return out;
}

function triageReasons(incident, t) {
  if (t.failed) return [reason("triage_failed", "Triage failed: re-run triage", ["start_triage"])];
  const pct = t.confidence != null ? ` (${Math.round(t.confidence * 100)}%)` : "";
  switch (t.verdict) {
    case "uncertain":
      return [
        reason(
          "triage_uncertain",
          t.lowConfidence ? `Triage low confidence${pct}: code fix or config?` : "Triage unsure: code fix or config error?",
          ["start_fix", "mark_config_error"],
        ),
      ];
    case "config_error":
      return [reason("triage_config_error", `Triage: config error${pct}`, ["mark_config_error", "start_fix"])];
    case "not_actionable":
      return [reason("triage_not_actionable", "Triage: nothing actionable", ["close", "start_fix"])];
    default:
      return [reason("fix_ready", `Triage: code fix${pct}. Start fix?`, ["start_fix", "mark_config_error"])];
  }
}

/** Protected-path info (label + base-system flag) from a result / event. */
export function protectedInfo(p) {
  const areas = Array.isArray(p?.areas) ? p.areas.map(String).filter((a) => /^[A-Za-z0-9 ._-]{1,40}$/.test(a)).slice(0, 8) : [];
  const label = areas.join(", ") || (typeof p?.label === "string" && /^[A-Za-z0-9 ,._-]{1,120}$/.test(p.label) ? p.label : "protected");
  return { label, core: p?.core === true || areas.includes("base system") };
}

function pushReason(fixMeta, job) {
  const acts = job ? ["retry_push"] : [];
  if (fixMeta.status === "ready_no_token") {
    return reason("ready_no_token", "Push pending: no fork-push token", acts, fixMeta.summary);
  }
  const cls = fixMeta.push_error ? ` (${fixMeta.push_error})` : "";
  return reason("push_failed", `Push failed${cls}: retry push`, acts, fixMeta.summary);
}

/**
 * Does this incident wait on Damo, and why? Pure: derived only from the row,
 * its events (triage_result / fix_result payloads, *_enqueued) and attempts.
 *
 * @param {object} incident  incidents row
 * @param {object[]} events  incident_events rows (any order; meta_json or meta)
 * @param {object[]} attempts fix_attempts rows
 * @returns {{ needed: boolean, reasons: {code:string,label:string,action:string|null,actions:string[],detail?:string}[] }}
 */
export const PR_STATE_LABELS = {
  open: "open",
  review_requested: "review requested",
  changes_requested: "changes requested",
  approved: "approved",
  merged: "merged",
  closed: "closed",
};

/**
 * PR loop state of an incident from its latest pr_state / pr_merged event
 * (worker PR results) plus the row's draft_pr_* columns, or null.
 * { number, url, state, reviewState, label, draft, round, maxRounds,
 *   lastFeedbackAt, revisePending, stopped, halted, untested, event, eventId }
 */
export function prInfo(incident, events = []) {
  const ev = latestEvent(events, ["pr_state", "pr_merged"]);
  const m = ev?.meta || {};
  const number = Number(m.pr_number || incident?.draft_pr_number) || null;
  if (!number && !ev) return null;
  const state = ["merged", "closed"].includes(m.pr_state) ? m.pr_state : m.pr_state === "open" || number ? "open" : null;
  const review = state === "open" && PR_STATE_LABELS[m.review_state] ? m.review_state : state || "open";
  return {
    number,
    url: incident?.draft_pr_url || null,
    state,
    reviewState: review,
    label: PR_STATE_LABELS[review] || review,
    draft: Boolean(m.pr_draft),
    round: Number(m.round) || 0,
    maxRounds: Number(m.max_rounds) || null,
    lastFeedbackAt: typeof m.last_feedback_at === "string" ? m.last_feedback_at : null,
    revisePending: Boolean(m.revise_pending) && !["revised", "halted", "merged", "closed"].includes(m.pr_event),
    stopped: Boolean(m.stopped),
    halted: typeof m.halted === "string" ? m.halted : null,
    untested: Boolean(m.untested),
    event: m.pr_event || null,
    eventId: ev ? Number(ev.id) : null,
  };
}

export function needsHumanInput(incident, events = [], attempts = [], opts = {}) {
  // Automated lab stage enabled on the host (autofix.lab.enable): a queued /
  // running lab test is worker progress, not a human task.
  const labAuto = opts.labAuto !== false;
  const reasons = [];
  // Testing with an automated lab job queued/running: progress, not a task.
  let labQueued = false;
  if (!incident) return { needed: false, reasons, labQueued };
  const status = incident.status;
  const triage = latestEvent(events, ["triage_result"]);
  const fix = latestEvent(events, ["fix_result"]);
  const triageEnq = latestEvent(events, ["triage_enqueued"]);
  // lab_approved = admin approved a protected lab test (the signed job is queued).
  const fixEnq = latestEvent(events, ["fix_enqueued", "push_enqueued", "lab_enqueued", "lab_approved"]);
  // A job cancelled while still pending never produces a result: its
  // job_cancelled event (meta.job_kind) ends the busy window instead.
  const cancelledOf = (kinds) =>
    latestEvent(events.filter((e) => e.kind === "job_cancelled" && kinds.includes(metaOf(e)?.job_kind)), ["job_cancelled"]);
  const triageEnd = [triage, cancelledOf(["triage"])].filter(Boolean).sort((x, y) => y.id - x.id)[0];
  const fixEnd = [fix, cancelledOf(["fix", "push", "lab"])].filter(Boolean).sort((x, y) => y.id - x.id)[0];
  const triageBusy = Boolean(triageEnq && (!triageEnd || triageEnq.id > triageEnd.id));
  const fixBusy = Boolean(fixEnq && (!fixEnd || fixEnq.id > fixEnd.id));
  const fm = fix?.meta || null;
  const nAttempts = Math.max(attempts.length, Number(fm?.attempts) || 0);

  switch (status) {
    case "open": {
      if (triageBusy) break;
      const t = interpretTriage(triage?.meta);
      if (t) reasons.push(...triageReasons(incident, t));
      else reasons.push(reason("not_triaged", "Not triaged yet", ["start_triage", "mark_config_error"]));
      break;
    }
    case "triaged": {
      if (triageBusy || fixBusy) break;
      if (fm && ["ready_no_token", "push_failed"].includes(fm.status)) {
        reasons.push(pushReason(fm, pushRetryJob(incident, fix)));
        break;
      }
      const t = interpretTriage(triage?.meta);
      if (t) reasons.push(...triageReasons(incident, t));
      else reasons.push(reason("fix_decision", "Triaged by hand: start fix or close?", ["start_fix", "mark_config_error"]));
      break;
    }
    case "testing": {
      if (fixBusy) {
        labQueued = fixEnq.kind === "lab_enqueued" || fixEnq.kind === "lab_approved";
        break;
      }
      const labCancel = cancelledOf(["lab"]);
      if (labCancel && (!fix || labCancel.id > fix.id)) {
        reasons.push(
          reason(
            "lab_cancelled",
            "Lab test cancelled",
            ["retry_lab", ...(incident.compare_url ? ["open_compare"] : [])],
            "The lab job was cancelled before it ran. Retry it, or test the branch manually and move the card to PR open.",
          ),
        );
        break;
      }
      if (fm && ["lab_queued", "lab_retry"].includes(fm.status) && labAuto) {
        labQueued = true;
        break;
      }
      if (fm?.lab === "cancelled" && fm.via === "lab") {
        reasons.push(
          reason(
            "lab_cancelled",
            "Lab test cancelled",
            ["retry_lab", ...(incident.compare_url ? ["open_compare"] : [])],
            "The automated lab test was cancelled before activation. Retry it, or test the branch manually and move the card to PR open.",
          ),
        );
        break;
      }
      if (fm?.status === "lab_error") {
        reasons.push(reason("lab_error", "Lab test error", ["retry_lab", "open_compare"], fm.summary));
        break;
      }
      if (!fm || !["passed", "failed"].includes(fm.lab)) {
        reasons.push(
          reason(
            "awaiting_lab_test",
            "Lab test needed",
            incident.compare_url ? ["open_compare"] : [],
            fm?.lab === "cancelled"
              ? "The automated lab test was cancelled before activation. Retry it, or test the branch manually and move the card to PR open."
              : fm?.status === "lab_queued"
                ? "A lab job is queued but automated lab testing is off on the host. Test the branch manually, then move the card to PR open."
                : "No lab result on the host (lab test skipped). Test the branch manually, then move the card to PR open.",
          ),
        );
      }
      break;
    }
    case "needs_human": {
      if (fixBusy) break;
      const job = pushRetryJob(incident, fix);
      const prEv = latestEvent(events, ["pr_state"]);
      const pm = prEv && (!fix || Number(prEv.id) > Number(fix.id)) ? prEv.meta || {} : null;
      if (pm?.pr_event === "closed") {
        reasons.push(reason("pr_closed", `PR #${pm.pr_number} closed without merge`, ["open_pr", "start_fix", ...(opts.prAuto ? ["adopt_pr"] : []), "close"], pm.summary));
      } else if (pm?.pr_event === "halted" && pm.halted === "revision_cap") {
        reasons.push(reason("revision_cap", `Revision cap reached (${pm.round}/${pm.max_rounds}): take over on GitHub`, ["open_pr", "mark_resolved", "close"], pm.summary));
      } else if (pm?.pr_event === "halted") {
        reasons.push(reason("pr_halted", `PR loop stopped on #${pm.pr_number} (${String(pm.halted || "error").replace(/_/g, " ")})`, ["open_pr", "start_fix", "mark_resolved"], pm.summary));
      } else if (pm?.pr_event === "blocked") {
        reasons.push(reason("pr_redaction_blocked", "Redaction gate blocked the PR text", ["start_fix", "close"], pm.summary));
      } else if (pm?.pr_event === "error" || fm?.status === "pr_open_failed") {
        const why = String(pm?.pr_error || fm?.pr_error || "unknown error").slice(0, 240);
        reasons.push(
          reason(
            "pr_open_failed",
            "Opening the PR failed: retry or adopt",
            [...(opts.prAuto ? ["retry_open_pr", "adopt_pr"] : []), ...(incident.compare_url ? ["open_compare"] : []), "close"],
            `The worker could not open the upstream PR (${why}). The compare link is kept. Retry open PR (an open PR for the branch is adopted), or open it from the compare link and Adopt PR with its number.`,
          ),
        );
      } else if (fm?.status === "lab_unavailable") {
        reasons.push(reason("no_lab_method", `No lab method for ${String(fm.target_repo || "this repo")}: test by hand`, ["skip_lab", "close"], fm.summary));
      } else if (fm?.unknown_target || (!fm && triage?.meta?.target_unknown)) {
        const t = fm?.unknown_target || triage.meta.target_unknown;
        reasons.push(reason("unknown_target", `Unknown target repo (${t}): not allowlisted`, ["start_fix", "close"], "Triage or the job named a repo outside services.ops.targets. Set an allowlisted target repo on the incident (or add the repo to the allowlist), then Start fix."));
      } else if (fm?.status === "lab_approval_needed") {
        // Protected path (ops / Hermes / swag / base system on the shared
        // ops/lab host): pushed, the lab test waits for the admin. The badge
        // stays until he approves or skips.
        const p = protectedInfo(fm.protected);
        const r = reason("lab_approval", `Protected path (${p.label}): approve lab test`, ["approve_lab", "skip_lab", "close"], fm.summary);
        r.protected = { label: p.label, core: p.core };
        reasons.push(r);
      } else if (fm?.services_unhealthy) {
        reasons.push(reason("services_unhealthy", "Ops/Hermes still down after the lab rollback: check the host", ["mark_resolved"], fm.summary));
      } else if (fm && (["ready_no_token", "push_failed"].includes(fm.status) || job)) {
        reasons.push(pushReason({ ...fm, status: fm.status === "ready_no_token" ? "ready_no_token" : "push_failed" }, job));
      } else if (fm?.status === "redaction_blocked") {
        reasons.push(reason("redaction_blocked", "Redaction gate blocked the push", ["start_fix", "close"], fm.summary));
      } else if (fm?.status === "denied") {
        // Legacy results (before protected paths got the approval flow).
        reasons.push(reason("denied", "Diff touches a deny-listed path", ["start_fix", "close"], fm.summary));
      } else if (fm?.lab === "error" && /ROLLBACK NOT VERIFIED/.test(String(fm.summary || ""))) {
        reasons.push(reason("rollback_unverified", "Lab rollback NOT verified: check the host", ["mark_resolved"], fm.summary));
      } else if (fm?.lab === "failed") {
        reasons.push(
          reason("lab_failed", `Lab test failed${nAttempts ? ` after ${nAttempts} attempt(s)` : ""}`, ["start_fix", "close"], fm.summary),
        );
      } else if (fm) {
        const max = Number(fm.max_attempts) || 0;
        const retried = (max && nAttempts >= max) || /gave up/i.test(String(fm.summary || ""));
        reasons.push(
          reason(
            retried ? "needs_human_after_retries" : "needs_human",
            retried ? `Hermes stuck after ${nAttempts || 1} attempt(s)` : `Worker needs a human (${fm.status || "error"})`,
            ["start_fix", "mark_config_error", "mark_resolved"],
            fm.summary,
          ),
        );
      } else if (triage?.meta?.status === "triage_failed") {
        reasons.push(reason("triage_failed", "Triage failed: re-run triage", ["start_triage"], triage.meta.summary));
      } else {
        reasons.push(reason("needs_human", "Flagged for a human", ["start_fix", "mark_config_error", "mark_resolved"]));
      }
      break;
    }
    case "pr_opened": {
      const skipped = latestEvent(events, ["lab_skipped"]);
      const untested = Boolean(skipped && (!fix || skipped.id > fix.id));
      const pr = prInfo(incident, events);
      const prJobPending = Boolean(latestEvent(events, ["pr_enqueued"]) && (!pr?.eventId || latestEvent(events, ["pr_enqueued"]).id > pr.eventId));
      // A tracked PR is worker progress (polling, revise rounds): no badge.
      if ((pr && pr.number && pr.state === "open") || (untested && skipped?.meta?.pr_job && !(pr?.eventId > Number(skipped.id))) || prJobPending) break;
      if (incident.compare_url && untested) {
        const p = protectedInfo(skipped.meta?.protected);
        const r = reason(
          "compare_untested",
          "Open the PR from the compare link (NOT lab-tested)",
          ["open_compare", ...(opts.prAuto ? ["adopt_pr"] : []), "mark_resolved"],
          `Lab test skipped by admin: the protected change (${p.label}) was NOT lab-tested. Review it carefully, open the upstream PR, merge, then mark resolved.`,
        );
        r.untested = true;
        reasons.push(r);
      } else if (incident.compare_url) {
        reasons.push(
          reason(
            "compare_ready",
            "Open the PR from the compare link",
            [...(opts.prAuto && fm?.lab === "passed" ? ["create_pr"] : []), "open_compare", ...(opts.prAuto ? ["adopt_pr"] : []), "mark_resolved"],
            fm?.lab === "passed" ? "Lab test passed. Open the upstream PR in GitHub, merge, then mark resolved." : undefined,
          ),
        );
      } else if (incident.draft_pr_url) {
        reasons.push(reason("pr_review", "PR open: merge, then mark resolved", ["mark_resolved"]));
      } else {
        reasons.push(reason("pr_link_missing", "PR open but no compare link", [...(opts.prAuto ? ["adopt_pr"] : []), "mark_resolved"]));
      }
      break;
    }
    default:
      // fixing (worker owns it), resolved, closed
      break;
  }
  return { needed: reasons.length > 0, reasons, labQueued };
}

// ------------------------------------------------------------- redaction

/**
 * systemd unit / file suffixes that are not real TLDs. Without this, the
 * FQDN rule turns "docker-searxng.service" into "[redacted-host]". The dot
 * is swapped for a private-use char only for the FQDN pass; every other
 * rule (known slugs, slug shape, emails, IPs, lab hosts, URLs) still applies.
 */
const SAFE_SUFFIX =
  /(?<=[A-Za-z0-9_-])\.(service|timer|socket|mount|target|slice|json|log|patch|mjs|cjs|js|nix|txt|toml|yaml|yml|conf|sqlite|lock)\b/g;
const PH = "\uE000";

/**
 * Display-only username rule on top of redact.js (which already covers
 * /home/<user> and user@host): "user=x", "username: x", "as/for/by user x",
 * "user 'x'". Kept out of redact.js so the worker's byte-identical copy and
 * its fail-closed gates are unchanged.
 */
const USERNAME =
  /\b((?:user(?:name)?|login|account)\s*[=:]\s*|(?:as|for|by|of) user\s+|user\s+(?=['"`]))(['"`]?)([A-Za-z0-9._-]{2,})\2/gi;

/** Display redactor over the shared redact.js rules. */
export function makeDisplayRedactor(knownSlugs = []) {
  return (text) => {
    if (text == null) return "";
    const s = String(text).split(PH).join("");
    const protectedText = s.replace(SAFE_SUFFIX, `${PH}$1`);
    return redactIdentifyingDetails(protectedText, { knownSlugs })
      .split(PH)
      .join(".")
      .replace(USERNAME, (_m, pre, q) => `${pre}${q}[redacted-user]${q}`);
  };
}

/** Link only if the URL survives redaction unchanged (github.com, no slug). */
export function safeLink(url, redact) {
  if (!url) return null;
  const s = String(url);
  if (!/^https:\/\/github\.com\//.test(s)) return null;
  return redact(s) === s ? s : null;
}

// ------------------------------------------------------------ summary/time

/** Short incident summary: latest triage summary, else first log line. */
export function incidentSummary(incident, events = []) {
  const t = latestEvent(events, ["triage_result"]);
  const fromTriage = t?.meta && t.meta.status !== "triage_failed" ? t.meta.summary : "";
  if (fromTriage && String(fromTriage).trim()) return String(fromTriage).trim();
  const line = String(incident?.logs_excerpt || "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return line || "No summary yet";
}

export function truncate(s, n) {
  const t = String(s || "");
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/** DB times are ISO (Z) or SQLite datetime('now') (UTC, no zone). */
export function parseDbTime(s) {
  if (!s) return null;
  let t = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(t)) t = `${t.replace(" ", "T")}Z`;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

let zurichFmt;
function zfmt() {
  if (!zurichFmt) {
    zurichFmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Zurich",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  }
  return zurichFmt;
}

/** "2026-09-30 11:59" in Europe/Zurich, or "". */
export function formatZurich(s) {
  const d = s instanceof Date ? s : parseDbTime(s);
  if (!d) return "";
  const p = Object.fromEntries(zfmt().formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Compact age: 12m, 5h, 3d, 2mo. */
export function ageLabel(s, now = new Date()) {
  const d = s instanceof Date ? s : parseDbTime(s);
  if (!d) return "";
  const min = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h`;
  const days = Math.floor(h / 24);
  if (days < 60) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

// ---------------------------------------------------------------- filters

export const FILTER_KEYS = ["q", "sev", "class", "unit", "repo", "mine", "cols"];

function one(v) {
  if (Array.isArray(v)) v = v[v.length - 1];
  return v == null ? "" : String(v).trim().slice(0, 200);
}

/**
 * URL query → filter state. cols: visible column keys (null = all).
 * Legacy ?status=<db status> shows only that status's column.
 */
export function parseFilters(query = {}) {
  let cols = null;
  const raw = query.cols;
  if (raw != null && raw !== "") {
    const list = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => String(v).split(","));
    const valid = list.map((s) => s.trim()).filter((k) => COLUMNS.some((c) => c.key === k));
    cols = valid.length ? [...new Set(valid)] : null;
  } else if (query.status && STATUS_LABELS[String(query.status)]) {
    cols = [columnForStatus(String(query.status))];
  }
  return {
    q: one(query.q),
    sev: one(query.sev),
    class: one(query.class),
    unit: one(query.unit),
    repo: one(query.repo),
    mine: ["1", "true", "on", "yes"].includes(one(query.mine).toLowerCase()),
    cols,
  };
}

export function hasActiveFilters(f) {
  return Boolean(f.q || f.sev || f.class || f.unit || f.repo || f.mine || f.cols);
}

/**
 * Card view model (already redacted) vs filters. Search only covers the
 * redacted searchText, never raw DB fields.
 */
export function cardMatches(card, f) {
  if (f.sev && card.severity !== f.sev) return false;
  if (f.class && card.klass !== f.class) return false;
  if (f.unit && card.unit !== f.unit) return false;
  if (f.repo && card.repo !== f.repo) return false;
  if (f.mine && !card.needed) return false;
  if (f.q) {
    const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = String(card.searchText || "").toLowerCase();
    if (!terms.every((t) => hay.includes(t))) return false;
  }
  return true;
}
