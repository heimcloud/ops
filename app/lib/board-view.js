/**
 * Kanban board HTML (server-rendered, progressively enhanced by
 * public/js/board.js). Every displayed free-text field goes through the
 * display redactor; customer_repo_slug / plugin_urls are never rendered.
 */
import { escapeHtml } from "./layout.js";
import {
  COLUMNS,
  STATUS_LABELS,
  TRANSITIONS,
  WORKER_OWNED,
  ACTIONS,
  columnForStatus,
  needsHumanInput,
  prInfo,
  incidentSummary,
  interpretTriage,
  safeLink,
  truncate,
  formatZurich,
  ageLabel,
  cardMatches,
  hasActiveFilters,
} from "./board.js";
import { resolveTargetRepo } from "./github.js";
import { liveIndicator, renderRunLine } from "./worker-view.js";
import { isAutofixKindEnabled } from "./queue.js";
import { normalizeLabReport } from "./lab-checks.js";

const esc = (s) => escapeHtml(s == null ? "" : s);

export const ICONS = {
  alert: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 1.2a1 1 0 0 1 .87.5l6.3 11a1 1 0 0 1-.87 1.5H1.7a1 1 0 0 1-.87-1.5l6.3-11A1 1 0 0 1 8 1.2Zm0 4a.8.8 0 0 0-.8.8v3.2a.8.8 0 0 0 1.6 0V6a.8.8 0 0 0-.8-.8Zm0 6.1a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z"/></svg>`,
  close: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3.7 2.3 8 6.6l4.3-4.3 1.4 1.4L9.4 8l4.3 4.3-1.4 1.4L8 9.4l-4.3 4.3-1.4-1.4L6.6 8 2.3 3.7z"/></svg>`,
  ext: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9 2h5v5h-1.6V4.7L7.6 9.5 6.5 8.4l4.8-4.8H9V2ZM3 4h4v1.6H3.6v6.8h6.8V9H12v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/></svg>`,
  search: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path fill="currentColor" d="M7 1.5a5.5 5.5 0 0 1 4.4 8.8l3.2 3.2-1.1 1.1-3.2-3.2A5.5 5.5 0 1 1 7 1.5Zm0 1.6a3.9 3.9 0 1 0 0 7.8 3.9 3.9 0 0 0 0-7.8Z"/></svg>`,
  lock: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 1a3.5 3.5 0 0 1 3.5 3.5V6H12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h.5V4.5A3.5 3.5 0 0 1 8 1Zm0 1.6a1.9 1.9 0 0 0-1.9 1.9V6h3.8V4.5A1.9 1.9 0 0 0 8 2.6Z"/></svg>`,
};

const SEV_RANK = { critical: 0, high: 1, error: 1, warning: 2, warn: 2, medium: 2, low: 3, info: 4 };

export function severityClass(sev) {
  const s = String(sev || "").toLowerCase();
  if (s === "critical") return "sev-crit";
  if (s === "high" || s === "error") return "sev-high";
  if (s === "warning" || s === "warn" || s === "medium") return "sev-warn";
  if (s === "low" || s === "info") return "sev-low";
  return "sev-none";
}

/**
 * @param {object} incident
 * @param {object[]} events
 * @param {object[]} attempts
 * @param {(s:string)=>string} redact display redactor
 * @param {{ now?: Date, caps?: object }} [opts]
 */
export function buildCardModel(incident, events, attempts, redact, opts = {}) {
  const now = opts.now || new Date();
  const hi = needsHumanInput(incident, events, attempts, {
    labAuto: opts.labAuto ?? isAutofixKindEnabled("lab"),
    prAuto: opts.prAuto ?? isAutofixKindEnabled("pr"),
  });
  const pri = prInfo(incident, events);
  const reasons = hi.reasons.map((r) => ({
    code: r.code,
    label: redact(r.label),
    action: r.action,
    actions: r.actions,
    ...(r.detail ? { detail: truncate(redact(r.detail), 400) } : {}),
    ...(r.protected ? { protected: { label: redact(r.protected.label), core: r.protected.core === true } } : {}),
    ...(r.untested ? { untested: true } : {}),
  }));
  const compareUrl = safeLink(incident.compare_url, redact);
  const summaryFull = redact(incidentSummary(incident, events));
  const severity = redact(String(incident.severity || "").toLowerCase());
  const unit = redact(incident.unit || "");
  const repo = redact(resolveTargetRepo(incident));
  const klass = redact(incident.class || "unknown");
  const actions = [];
  for (const r of reasons) for (const a of r.actions) if (!actions.includes(a)) actions.push(a);
  const model = {
    id: incident.id,
    status: incident.status,
    statusLabel: STATUS_LABELS[incident.status] || incident.status,
    column: columnForStatus(incident.status),
    severity,
    klass,
    unit,
    repo,
    summary: truncate(summaryFull, 150),
    summaryFull,
    created: formatZurich(incident.created_at),
    updated: formatZurich(incident.updated_at),
    age: ageLabel(incident.created_at, now),
    attempts: attempts.length,
    needed: hi.needed,
    reasons,
    actions,
    compareUrl,
    allowedMoves: TRANSITIONS[incident.status] || [],
    labRun: labSummary(events, redact),
    labQueued: Boolean(hi.labQueued),
    // Protected fix waiting for "Approve lab test" / skipped lab (warning chip).
    protectedLab: reasons.find((r) => r.protected)?.protected || null,
    untested: reasons.some((r) => r.untested) || Boolean(pri?.untested && pri.state === "open"),
    pr: pri
      ? {
          number: pri.number,
          url: safeLink(pri.url, redact),
          state: pri.state,
          reviewState: pri.reviewState,
          label: pri.label,
          draft: pri.draft,
          round: pri.round,
          maxRounds: pri.maxRounds,
          lastFeedback: pri.lastFeedbackAt ? formatZurich(pri.lastFeedbackAt) : "",
          revisePending: pri.revisePending,
          stopped: pri.stopped,
          halted: pri.halted,
        }
      : null,
  };
  model.searchText = [
    `#${model.id}`,
    model.summaryFull,
    model.unit,
    model.klass,
    model.severity,
    model.repo,
    model.statusLabel,
    ...reasons.map((r) => r.label),
  ]
    .join(" ")
    .toLowerCase();
  return model;
}

/** Latest automated lab report of the incident (redacted, normalized) or null. */
function latestLabEvent(events) {
  let best = null;
  for (const e of events || []) {
    if (e.kind !== "fix_result") continue;
    const m = e.meta !== undefined ? e.meta : parseMeta(e.meta_json);
    if (!m?.lab_report || m.via !== "lab") continue;
    if (!best || Number(e.id) > Number(best.e.id)) best = { e, m };
  }
  return best;
}

function parseMeta(j) {
  try {
    return j ? JSON.parse(j) : null;
  } catch {
    return null;
  }
}

export function labSummary(events, redact) {
  const best = latestLabEvent(events);
  if (!best) return null;
  const r = normalizeLabReport(best.m.lab_report);
  if (!r) return null;
  // Checks Hermes planned that were dropped (by the worker's or the runner's
  // validation): never silent, shown on the card and in the drawer.
  const dropped = [
    ...new Set([
      ...r.planNotes.filter((l) => /^check #\d+ dropped: /.test(l)),
      ...r.planErrors.map((e) => `check ${e.replace(/^(#\d+):\s*/, "$1 dropped: ")}`),
    ]),
  ]
    .slice(0, 8)
    .map((l) => redact(l));
  return {
    verdict: r.verdict,
    passed: r.passed,
    failed: r.failed,
    total: r.checks.length,
    dropped,
    activationWarning: redact(r.activationWarning),
    attempt: Number(best.m.attempts) || null,
    maxAttempts: Number(best.m.max_attempts) || null,
    at: formatZurich(best.e.created_at),
    report: {
      ...r,
      reason: redact(r.reason),
      failedStage: redact(r.failedStage),
      checks: r.checks.map((c) => ({ ...c, label: redact(c.label), detail: redact(c.detail) })),
      evidence: r.evidence.map((l) => redact(l)),
      planNotes: r.planNotes.map((l) => redact(l)),
      generation: { ...r.generation, labToplevel: redact(r.generation.labToplevel) },
      protected: r.protected ? { ...r.protected, label: redact(r.protected.label), paths: r.protected.paths.map((p) => redact(p)) } : null,
      protectedProbe: redactSvc(r.protectedProbe, redact),
      postRollbackServices: redactSvc(r.postRollbackServices, redact),
      servicesReason: redact(r.servicesReason),
    },
  };
}

function redactSvc(p, redact) {
  if (!p) return null;
  const one = (v) => (v ? { ...v, detail: redact(v.detail) } : null);
  return { ops: one(p.ops), hermes: one(p.hermes) };
}

/** Drawer model: card model + redacted timeline, attempts, lab, links. */
export function buildDrawerModel(incident, events, attempts, redact, opts = {}) {
  const card = buildCardModel(incident, events, attempts, redact, opts);
  const parse = (e) => {
    if (e.meta !== undefined) return e.meta;
    try {
      return e.meta_json ? JSON.parse(e.meta_json) : null;
    } catch {
      return null;
    }
  };
  const evs = [...events]
    .sort((a, b) => Number(b.id) - Number(a.id))
    .map((e) => {
      const m = parse(e) || {};
      const bits = [];
      if (m.from && m.to) bits.push(`${m.from} → ${m.to}`);
      if (m.note) bits.push(String(m.note));
      if (e.kind === "fix_result" || e.kind === "triage_result") {
        if (m.status) bits.push(`status ${m.status}`);
        if (m.lab) bits.push(`lab ${m.lab}`);
        if (m.push_error) bits.push(`push ${m.push_error}`);
        if (m.verdict) bits.push(`verdict ${m.verdict}`);
        if (m.confidence != null) bits.push(`confidence ${m.confidence}`);
      }
      return {
        id: e.id,
        kind: redact(e.kind),
        message: truncate(redact(e.message || ""), 600),
        meta: redact(bits.join(" · ")),
        at: formatZurich(e.created_at),
      };
    });
  const lastFix = [...events].filter((e) => e.kind === "fix_result").sort((a, b) => Number(b.id) - Number(a.id))[0];
  const fm = lastFix ? parse(lastFix) || {} : {};
  const lastTriage = [...events].filter((e) => e.kind === "triage_result").sort((a, b) => Number(b.id) - Number(a.id))[0];
  const t = lastTriage ? interpretTriage(parse(lastTriage)) : null;
  return {
    ...card,
    reportHash: String(incident.report_hash || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 12),
    neoVersion: redact(incident.neo_version || ""),
    branch: redact(incident.draft_branch || ""),
    prTitle: redact(incident.prepared_pr_title || ""),
    draftPrUrl: safeLink(incident.draft_pr_url, redact),
    compareUrlRaw: incident.compare_url ? (card.compareUrl ? card.compareUrl : redact(incident.compare_url)) : "",
    lab: fm.lab ? redact(String(fm.lab)) : "",
    labSummary: fm.lab === "failed" || fm.lab === "passed" || fm.lab === "skipped" ? truncate(redact(fm.summary || ""), 600) : "",
    triage: t ? { verdict: t.verdict, confidence: t.confidence, legacy: t.legacy } : null,
    logsExcerpt: truncate(redact(incident.logs_excerpt || ""), 2000),
    events: evs,
    attemptsTable: attempts.map((a) => {
      const m = parse(a) || {};
      return {
        attempt: a.attempt,
        branch: redact(a.branch || ""),
        result: redact(a.result || ""),
        lab: redact(m.lab || ""),
        at: formatZurich(a.created_at),
      };
    }),
  };
}

// ---------------------------------------------------------------- actions

function actionForm(base, card, action, caps, { compact = false } = {}) {
  const id = card.id;
  const cls = compact ? "kbtn" : "kbtn kbtn-lg";
  const primary = card.reasons[0]?.action === action ? " primary" : "";
  if (action === "open_compare") {
    if (!card.compareUrl) return "";
    return `<a class="${cls}${primary}" href="${esc(card.compareUrl)}" target="_blank" rel="noopener">${esc(ACTIONS.open_compare)} ${ICONS.ext}</a>`;
  }
  if (action === "open_pr") {
    if (!card.pr?.url) return "";
    return `<a class="${cls}${primary}" href="${esc(card.pr.url)}" target="_blank" rel="noopener">${esc(ACTIONS.open_pr)} ${ICONS.ext}</a>`;
  }
  if (caps.readOnly) return "";
  let path = `${base}/incidents/${id}`;
  let hidden = `<input type="hidden" name="_action" value="${esc(action)}" />`;
  let confirm = "";
  let extraCls = "";
  let label = ACTIONS[action];
  if (action === "start_triage") {
    if (!caps.triage) return "";
    path += "/start-triage";
    hidden = "";
  } else if (action === "start_fix") {
    if (!caps.fix) return "";
    path += "/start-fix";
    hidden = "";
    confirm = `Enqueue a fix job for incident #${id}? (local Hermes, fork branch, compare link; no auto-merge)`;
  } else if (action === "retry_lab") {
    if (!caps.lab) return "";
    path += "/retry-lab";
    hidden = "";
    confirm = `Re-run the automated lab test for incident #${id}? (activates the fix branch on the lab host, then rolls back)`;
  } else if (action === "approve_lab") {
    if (!caps.lab) return "";
    path += "/approve-lab";
    hidden = "";
    const p = card.protectedLab || { label: "protected", core: false };
    const wd = Math.round((Number(caps.protectedWatchdogSec) || 600) / 60);
    if (p.core) {
      extraCls = " danger";
      label = "Approve lab test (base system!)";
      confirm =
        `BASE SYSTEM change (${p.label}) for incident #${id}. The lab test activates it on the shared ops/lab host and can cut ` +
        `network / SSH / the ops app / Hermes / the worker there. The root runner rolls back as soon as ops or Hermes is down, ` +
        `the watchdog rolls back after ${wd} min at the latest, then ops and Hermes are checked and restarted. ` +
        `If the host stays unreachable you need console access. Approve the lab test?`;
    } else {
      confirm =
        `Protected change (${p.label}) for incident #${id}: the lab test activates it on the shared ops/lab host and may take down ` +
        `ops, Hermes or the worker for a moment. Rollback is immediate if ops or Hermes goes down (watchdog ${wd} min). Approve the lab test?`;
    }
  } else if (action === "skip_lab") {
    path += "/skip-lab";
    hidden = "";
    confirm = caps.pr
      ? `Skip the lab test for incident #${id}? The worker opens the upstream PR as a DRAFT marked "NOT lab-tested" (or, in a review round, pushes the reply marked so).`
      : `Open the compare link for incident #${id} WITHOUT a lab test? The card moves to PR open marked "NOT lab-tested".`;
  } else if (action === "create_pr") {
    if (!caps.pr) return "";
    path += "/open-pr";
    hidden = "";
    confirm = `Open the upstream PR for incident #${id} from its lab-tested branch? (never auto-merged)`;
  } else if (action === "retry_open_pr") {
    if (!caps.pr) return "";
    path += "/open-pr";
    hidden = "";
    confirm = `Retry opening the upstream PR for incident #${id}? (an already open PR for the fix branch is adopted instead)`;
  } else if (action === "adopt_pr") {
    if (!caps.pr) return "";
    // Number input: the PR was opened outside the worker (e.g. from the compare link).
    return `<form class="act-form adopt-form" method="post" action="${esc(`${path}/adopt-pr`)}" data-confirm="${esc(
      `Adopt this PR for incident #${id}? It must be an open PR from the heimcloud fork (fix/* or ops/* branch) on the target upstream. Only comments after adoption drive revisions.`,
    )}">
      <input type="hidden" name="return_to" value="board" />
      <label class="sr-only" for="adopt-${id}">PR number for #${id}</label>
      <input id="adopt-${id}" class="adopt-num" name="pr_number" type="number" min="1" step="1" required placeholder="PR #" />
      <button class="${cls}${primary}" type="submit">${esc(label)}</button>
    </form>`;
  } else if (action === "retry_push") {
    if (!caps.push) return "";
    path += "/retry-push";
    hidden = "";
    confirm = `Retry pushing the saved fix for incident #${id}? (no new Hermes run)`;
  } else if (action === "mark_config_error") {
    confirm = `Close incident #${id} as a config error (class human_config)?`;
  } else if (action === "close") {
    confirm = `Close incident #${id}?`;
  }
  return `<form class="act-form" method="post" action="${esc(path)}"${confirm ? ` data-confirm="${esc(confirm)}"` : ""}>
      ${hidden}<input type="hidden" name="return_to" value="board" />
      <button class="${cls}${primary}${extraCls}" type="submit">${esc(label)}</button>
    </form>`;
}

function moveForm(base, card, caps) {
  if (caps.readOnly) return "";
  const opts = card.allowedMoves
    .map((s) => `<option value="${esc(s)}">${esc(STATUS_LABELS[s])}</option>`)
    .join("");
  if (!opts) return "";
  return `<form class="move-form" method="post" action="${esc(`${base}/incidents/${card.id}`)}">
      <input type="hidden" name="_action" value="move" />
      <input type="hidden" name="return_to" value="board" />
      <input type="hidden" name="expect_from" value="${esc(card.status)}" />
      <label class="sr-only" for="mv-${card.id}">Move #${card.id} to</label>
      <select id="mv-${card.id}" name="status" class="move-select">
        <option value="" selected disabled>Move to…</option>${opts}
      </select>
      <button class="kbtn nojs-only" type="submit">Move</button>
    </form>`;
}

// ------------------------------------------------------------------- card

export function renderCard(card, base, caps, { hidden = false } = {}) {
  const sevCls = severityClass(card.severity);
  const draggable = !caps.readOnly && card.allowedMoves.length > 0;
  const top = card.reasons[0];
  const doneTag =
    card.column === "done"
      ? `<span class="chip tag-${esc(card.status)}">${esc(card.statusLabel.toLowerCase())}</span>`
      : "";
  const shown = card.actions.filter((a) => a !== "close" || card.reasons[0]?.action === "close").slice(0, 3);
  const actions = shown.map((a) => actionForm(base, card, a, caps, { compact: true })).join("");
  return `<article class="kcard ${sevCls}${card.needed ? " needs" : ""}" id="incident-${card.id}"
    data-id="${card.id}" data-status="${esc(card.status)}" data-sev="${esc(card.severity)}"
    data-class="${esc(card.klass)}" data-unit="${esc(card.unit)}" data-repo="${esc(card.repo)}"
    data-needed="${card.needed ? "1" : "0"}" data-search="${esc(card.searchText)}"
    ${draggable ? `draggable="true"` : ""}${hidden ? " hidden" : ""} aria-label="Incident #${card.id}: ${esc(card.summary)}">
    <div class="kc-top">
      <a class="kc-id" href="${esc(`${base}/incidents/${card.id}/drawer`)}" data-open="${card.id}">#${card.id}</a>
      <span class="chip sev ${sevCls}">${esc(card.severity || "n/a")}</span>
      ${doneTag}
      <span class="kc-age" title="Created ${esc(card.created)} (Zurich)">${esc(card.age)}</span>
    </div>
    <p class="kc-sum" title="${esc(card.summaryFull)}">${esc(card.summary)}</p>
    <div class="kc-meta">
      ${card.unit ? `<span class="kc-unit" title="${esc(card.unit)}">${esc(card.unit)}</span>` : ""}
      <span class="kc-cls" title="Class">${esc(card.klass)}</span>
      <span title="Hermes fix attempts">${card.attempts} attempt${card.attempts === 1 ? "" : "s"}</span>
    </div>
    ${
      top
        ? `<div class="kc-need" title="${esc(card.reasons.map((r) => r.label).join(" · "))}">${ICONS.alert}<span>${esc(top.label)}</span></div>`
        : ""
    }
    ${card.protectedLab?.core ? `<div class="kc-warn" title="The fix touches the base system of the shared ops/lab host">BASE SYSTEM change: lab test needs your approval</div>` : ""}
    ${card.untested ? `<div class="kc-warn" title="Lab test skipped by admin">NOT lab-tested</div>` : ""}
    ${card.pr?.number ? renderPrLine(card.pr) : ""}
    ${caps.runningJob && caps.runningJob.incidentId === card.id ? renderRunLine(caps.runningJob) : card.labQueued ? `<div class="kc-labq" title="Automated lab test: the worker runs it; no action needed">Automated lab test queued</div>` : ""}
    ${card.labRun && ["testing", "needs_human", "pr_opened", "fixing"].includes(card.status) ? renderLabLine(card.labRun) : ""}
    ${actions || (!caps.readOnly && card.allowedMoves.length) ? `<div class="kc-actions">${actions}${moveForm(base, card, caps)}</div>` : ""}
  </article>`;
}

/** One-line PR loop state on a card: #n, state, draft, round, last feedback. */
export function renderPrLine(pr) {
  const st = pr.state === "open" ? pr.reviewState : pr.state;
  const bits = [
    pr.draft && pr.state === "open" ? "draft" : "",
    pr.maxRounds ? `round ${pr.round}/${pr.maxRounds}` : "",
    pr.revisePending ? "revision running" : "",
    pr.stopped ? "automation stopped" : "",
    pr.halted ? `halted: ${String(pr.halted).replace(/_/g, " ")}` : "",
  ].filter(Boolean);
  const link = pr.url ? `<a href="${esc(pr.url)}" target="_blank" rel="noopener">PR #${esc(pr.number)} ${ICONS.ext}</a>` : `PR #${esc(pr.number)}`;
  return `<div class="kc-pr pr-${esc(st)}" data-pr-state="${esc(st)}" title="${esc(pr.lastFeedback ? `Last reviewer comment ${pr.lastFeedback} (Zurich)` : "No reviewer comment yet")}">
      ${link} <span class="chip pr-st">${esc(pr.label)}</span>${bits.length ? ` <span class="muted">${esc(bits.join(" · "))}</span>` : ""}${pr.lastFeedback ? ` <span class="muted">· feedback ${esc(pr.lastFeedback)}</span>` : ""}
    </div>`;
}

const VERDICT_LABEL = { pass: "passed", fail: "failed", error: "error", cancelled: "cancelled" };

/** One-line lab result on a card: verdict + per-check pass/fail counts. */
export function renderLabLine(l) {
  const v = VERDICT_LABEL[l.verdict] ? l.verdict : "error";
  return `<div class="kc-lab v-${v}" title="Automated lab test ${esc(VERDICT_LABEL[v])} (${esc(l.at)})">
      <span class="kc-lab-v">Lab ${esc(VERDICT_LABEL[v])}</span>
      <span class="kc-lab-n ok" aria-label="${l.passed} passed">✓ ${l.passed}</span>
      <span class="kc-lab-n bad" aria-label="${l.failed} failed">✗ ${l.failed}</span>
    </div>${
      l.dropped?.length
        ? `<div class="kc-lab-note warnv" data-lab-dropped title="${esc(l.dropped.join("\n"))}">⚠ ${esc(l.dropped[0])}${l.dropped.length > 1 ? ` (+${l.dropped.length - 1} more)` : ""}</div>`
        : ""
    }${l.activationWarning ? `<div class="kc-lab-note warnv" data-lab-actwarn>⚠ activation ${esc(l.activationWarning)}</div>` : ""}`;
}

/** Drawer section: the full per-check list + rollback guarantees. */
function svcPair(p) {
  const one = (name, v) =>
    v ? `${name} <span class="${v.ok ? "okv" : "badv"}">${v.ok ? "ok" : "down"}</span>${v.restarted ? " (restarted)" : ""}${v.detail ? ` <span class="muted">${esc(v.detail)}</span>` : ""}` : "";
  return [one("ops /health", p.ops), one("Hermes", p.hermes)].filter(Boolean).join(" · ");
}

export function renderLabReport(l) {
  const r = l.report;
  const v = VERDICT_LABEL[r.verdict] ? r.verdict : "error";
  const g = r.generation;
  const gen =
    g.before != null
      ? `${esc(g.before)} → lab → ${esc(g.after ?? "?")} ${g.restored ? `<span class="okv">restored</span>` : `<span class="badv">not verified</span>`}${g.bootedUnchanged ? "" : ` · <span class="badv">booted system changed</span>`}`
      : `<span class="muted">not activated</span>`;
  const wd = r.watchdog.fired
    ? `<span class="badv">fired (runner did not finish)</span>`
    : r.watchdog.armed
      ? `armed · ${r.watchdog.disarmed ? `<span class="okv">disarmed</span>` : `<span class="warnv">still armed</span>`}`
      : `<span class="muted">not armed</span>`;
  const pins = r.pinsIdentical ? `<span class="okv">byte-identical</span>` : r.pinsRestored ? `<span class="warnv">changed, restored from backup</span>` : g.before != null ? `<span class="badv">not verified</span>` : `<span class="muted">—</span>`;
  const act =
    r.activationExit != null
      ? `exit ${esc(r.activationExit)}${l.activationWarning ? ` <span class="warnv">(${esc(l.activationWarning)})</span>` : ""}`
      : `<span class="muted">—</span>`;
  const checks = r.checks.length
    ? `<ul class="lab-checks">${r.checks
        .map(
          (c) => `<li class="${c.ok ? "ok" : "bad"}"><span class="ck" aria-label="${c.ok ? "pass" : "fail"}">${c.ok ? "✓" : "✗"}</span>
            <span class="lbl">${esc(c.label)}${c.generic ? ` <span class="chip gen">generic</span>` : ""}</span>
            ${c.detail ? `<span class="det">${esc(c.detail)}</span>` : ""}</li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">No checks ran${r.failedStage ? ` (stopped at ${esc(r.failedStage)})` : ""}.</p>`;
  return `<section class="lab-rep v-${v}" data-lab-report>
    <h3>Automated lab test <span class="chip lab-${esc(v === "pass" ? "passed" : v === "fail" ? "failed" : v)}">${esc(VERDICT_LABEL[v])}</span>
      <span class="muted">${esc(l.at)}${l.attempt ? ` · attempt ${esc(l.attempt)}/${esc(l.maxAttempts || "?")}` : ""} · ${r.passed}/${r.checks.length} checks</span></h3>
    ${r.reason ? `<p class="lab-reason">${esc(r.reason)}</p>` : ""}
    ${checks}
    <dl class="dr-kv lab-kv">
      <div><dt>Generation</dt><dd>${gen}</dd></div>
      ${r.protected ? `<div><dt>Protected</dt><dd><span class="${r.protected.core ? "badv" : "warnv"}">${esc(r.protected.label)}${r.protected.core ? " (BASE SYSTEM)" : ""}</span> · ${r.protected.approved ? `approved by admin${r.protected.approvalEventId ? ` (event #${esc(r.protected.approvalEventId)})` : ""}` : `<span class="badv">not approved</span>`}</dd></div>` : ""}
      <div><dt>Watchdog</dt><dd>${wd}${r.watchdog.deadlineSec ? ` <span class="muted">· deadline ${esc(Math.round(r.watchdog.deadlineSec / 60))} min</span>` : ""}</dd></div>
      ${r.protectedProbe ? `<div><dt>Ops / Hermes after activation</dt><dd>${svcPair(r.protectedProbe)}</dd></div>` : ""}
      ${r.postRollbackServices ? `<div><dt>Services after rollback</dt><dd>${svcPair(r.postRollbackServices)}${r.servicesUnhealthy ? ` · <span class="badv">STILL DOWN: check the host</span>` : ""}</dd></div>` : ""}
      <div><dt>Pins (lock/flake/settings)</dt><dd>${pins}</dd></div>
      <div><dt>Tested commit</dt><dd>${r.testedRev ? `<code>${esc(r.testedRev)}</code> (fork branch tip = gated commit)` : `<span class="muted">—</span>`}</dd></div>
      <div><dt>Activation</dt><dd>${act}${r.durationSec != null ? ` · run ${esc(Math.round(r.durationSec))} s` : ""}</dd></div>
      ${l.dropped?.length ? `<div><dt>Dropped checks</dt><dd><span class="warnv">${esc(l.dropped.join("; "))}</span></dd></div>` : ""}
      <div><dt>Check plan</dt><dd>${r.planSource === "hermes" ? "Hermes" : r.planSource === "default" ? "default (Hermes plan unusable)" : "—"}${r.planNotes.length ? ` <span class="muted">· ${esc(r.planNotes.join("; "))}</span>` : ""}</dd></div>
    </dl>
    ${r.evidence.length ? `<details class="dr-logs"><summary>Evidence (redacted, ${r.evidence.length} lines)</summary><pre>${esc(r.evidence.join("\n"))}</pre></details>` : ""}
  </section>`;
}

// ------------------------------------------------------------------ board

function selectFilter(name, label, values, current) {
  const opts = values
    .map((v) => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(v)}</option>`)
    .join("");
  return `<label class="f-field"><span class="sr-only">${esc(label)}</span>
    <select name="${name}" aria-label="${esc(label)}"><option value="">${esc(label)}: all</option>${opts}</select></label>`;
}

function uniqSorted(list, cmp) {
  return [...new Set(list.filter(Boolean))].sort(cmp);
}

/**
 * @param {{ cards: object[], counts: Record<string,number>, filters: object, base: string, caps: object, status: object, flash?: string }} p
 */
export function renderBoard({ cards, counts, filters, base, caps, status, flash = "", panel = "", rev = "" }) {
  const visibleCols = filters.cols ? new Set(filters.cols) : null;
  const matches = new Map(cards.map((c) => [c.id, cardMatches(c, filters)]));
  const sevs = uniqSorted(
    cards.map((c) => c.severity),
    (a, b) => (SEV_RANK[a] ?? 9) - (SEV_RANK[b] ?? 9) || a.localeCompare(b),
  );
  const classes = uniqSorted(cards.map((c) => c.klass));
  const units = uniqSorted(cards.map((c) => c.unit));
  const repos = uniqSorted(cards.map((c) => c.repo));
  const needTotal = cards.filter((c) => c.needed).length;

  const colChecks = COLUMNS.map(
    (c) => `<label class="colchk"><input type="checkbox" name="cols" value="${c.key}"${!visibleCols || visibleCols.has(c.key) ? " checked" : ""} /> ${esc(c.label)}</label>`,
  ).join("");

  const filterBar = `<form class="filters" method="get" action="${esc(`${base}/`)}" role="search" aria-label="Board filters">
    <label class="f-search">${ICONS.search}<span class="sr-only">Search</span>
      <input type="search" name="q" value="${esc(filters.q)}" placeholder="Search #id, summary, unit, reason…" autocomplete="off" /></label>
    ${selectFilter("sev", "Severity", sevs, filters.sev)}
    ${selectFilter("class", "Class", classes, filters.class)}
    ${selectFilter("unit", "Unit", units, filters.unit)}
    ${selectFilter("repo", "Target repo", repos, filters.repo)}
    <label class="f-toggle"><input type="checkbox" name="mine" value="1"${filters.mine ? " checked" : ""} />
      <span class="tgl" aria-hidden="true"></span><span>Needs my input</span><span class="pill" data-need-total>${needTotal}</span></label>
    <details class="f-cols"><summary>Columns <span class="muted" data-cols-count>${visibleCols ? visibleCols.size : COLUMNS.length}/${COLUMNS.length}</span></summary>
      <div class="f-cols-menu">${colChecks}</div></details>
    <button class="kbtn nojs-only" type="submit">Apply</button>
    <a class="f-reset" href="${esc(`${base}/`)}" data-reset${hasActiveFilters(filters) ? "" : " hidden"}>Reset</a>
  </form>`;

  const columns = COLUMNS.map((col) => {
    const colCards = cards
      .filter((c) => c.column === col.key)
      .sort((a, b) => Number(b.needed) - Number(a.needed) || b.id - a.id);
    const shown = colCards.filter((c) => matches.get(c.id));
    const need = colCards.filter((c) => c.needed).length;
    const total = col.statuses.reduce((n, s) => n + (counts[s] || 0), 0);
    const sub =
      col.key === "done"
        ? `<span class="col-sub">${counts.resolved || 0} resolved · ${counts.closed || 0} closed</span>`
        : need
          ? `<span class="col-sub need" data-col-need>${need} need input</span>`
          : `<span class="col-sub" data-col-need></span>`;
    const lock = col.workerOwned ? `<span class="col-lock" title="Worker-owned: cards can't be dropped here">${ICONS.lock}</span>` : "";
    const zones =
      col.key === "done"
        ? `<div class="done-zones" aria-hidden="true"><div class="dropzone sub" data-drop="resolved">Resolved</div><div class="dropzone sub" data-drop="closed">Closed</div></div>`
        : "";
    const body = colCards.map((c) => renderCard(c, base, caps, { hidden: !matches.get(c.id) })).join("");
    return `<section class="kcol col-${col.key}" data-col="${col.key}" data-statuses="${col.statuses.join(",")}"${visibleCols && !visibleCols.has(col.key) ? " hidden" : ""} aria-labelledby="h-${col.key}">
      <header class="kcol-h">
        <h2 id="h-${col.key}">${esc(col.label)}${lock}</h2>
        <span class="count" title="${total} total" data-col-count>${shown.length === total ? total : `${shown.length}/${total}`}</span>
        ${sub}
      </header>
      ${zones}
      <div class="kcol-body dropzone" data-drop="${col.key === "done" ? "done" : col.statuses[0]}">${body}
        <p class="kcol-empty">${col.workerOwned ? "Set by the worker" : "No incidents"}</p>
      </div>
    </section>`;
  }).join("");

  const cfg = {
    base,
    readOnly: Boolean(caps.readOnly),
    transitions: TRANSITIONS,
    workerOwned: WORKER_OWNED,
    labels: STATUS_LABELS,
    columns: COLUMNS.map((c) => ({ key: c.key, label: c.label, statuses: c.statuses })),
    rev,
    page: "board",
  };
  const statusBits = [
    `triage ${caps.triage ? "on" : "off"}`,
    `fix ${caps.fix ? "on" : "off"}`,
    `fork token ${status.token}`,
    caps.prLoop?.label || `PR loop ${caps.pr ? "on" : "off"}`,
  ];
  const validate =
    caps.pr && caps.fix && !caps.readOnly
      ? `<form class="act-form board-validate" method="post" action="${esc(`${base}/validation/pr-loop`)}" data-confirm="${esc(
          "Run the PR-loop validation? Creates a synthetic incident, pushes a harmless doc-only branch (ops/validation-pr-loop-<id>) to heimcloud/neo, lab-tests it and opens a real PR on madebydamo/neo labelled [validation] DO NOT MERGE. Review-comment it once to drive one feedback round, then close it.",
        )}"><input type="hidden" name="return_to" value="board" /><button class="kbtn" type="submit">Run PR-loop validation</button></form>`
      : "";
  return `<div class="board-wrap${caps.readOnly ? " is-ro" : ""}">
    <div class="board-head">
      <h1>Incidents</h1>
      <p class="board-status muted">Autofix: ${statusBits.map(esc).join(" · ")}${status.allowlist ? ` · allowlist <code>${esc(status.allowlist.join(", "))}</code>` : ""}${caps.readOnly ? ` · <strong class="ro">read-only</strong>` : ""}</p>
      ${liveIndicator()}
      ${validate}
    </div>
    ${flash}
    <div data-worker-slot>${panel}</div>
    ${filterBar}
    <div class="board" data-board>${columns}</div>
    <div class="drawer-backdrop" data-drawer-backdrop hidden></div>
    <aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" hidden tabindex="-1">
      <div class="drawer-inner" data-drawer-inner></div>
    </aside>
    <div class="toasts" aria-live="polite" aria-atomic="false" data-toasts></div>
    <script type="application/json" id="board-config">${JSON.stringify(cfg).replace(/</g, "\\u003c")}</script>
    <script type="application/json" id="live-config">${JSON.stringify({ base, rev, page: "board", readOnly: Boolean(caps.readOnly), now: Date.now() }).replace(/</g, "\\u003c")}</script>
    <script src="/js/live.js" defer></script>
    <script src="/js/board.js" defer></script>
  </div>`;
}

// ----------------------------------------------------------------- drawer

export function renderDrawer(d, base, caps) {
  const sevCls = severityClass(d.severity);
  const reasons = d.reasons.length
    ? `<section class="dr-need"><h3>${ICONS.alert} Needs your input</h3><ul>${d.reasons
        .map(
          (r) => `<li><strong>${esc(r.label)}</strong>${r.detail ? `<p class="muted">${esc(r.detail)}</p>` : ""}</li>`,
        )
        .join("")}</ul></section>`
    : `<section class="dr-need none"><p class="muted">Nothing waiting on you.</p></section>`;
  const actionList = [...d.actions];
  for (const a of d.status === "resolved" || d.status === "closed" ? [] : ["mark_resolved", "mark_config_error"]) {
    if (!actionList.includes(a)) actionList.push(a);
  }
  const actions = actionList.map((a) => actionForm(base, d, a, caps)).join("");
  const kv = (k, v) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
  const events = d.events.length
    ? `<ol class="timeline">${d.events
        .map(
          (e) => `<li><div class="tl-h"><code class="kind k-${esc(e.kind.replace(/[^a-z_]/g, ""))}">${esc(e.kind)}</code><time>${esc(e.at)}</time></div>
            ${e.message ? `<p>${esc(e.message)}</p>` : ""}${e.meta ? `<p class="muted small">${esc(e.meta)}</p>` : ""}</li>`,
        )
        .join("")}</ol>`
    : `<p class="muted">No events.</p>`;
  const attempts = d.attemptsTable.length
    ? `<table class="dr-table"><thead><tr><th>#</th><th>Branch</th><th>Result</th><th>Lab</th><th>When</th></tr></thead><tbody>${d.attemptsTable
        .map(
          (a) => `<tr><td>${esc(a.attempt)}</td><td><code>${esc(a.branch || "—")}</code></td><td>${esc(a.result || "—")}</td><td>${esc(a.lab || "—")}</td><td class="nowrap">${esc(a.at)}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">No Hermes fix attempts yet.</p>`;
  const compare = d.compareUrl
    ? `<a href="${esc(d.compareUrl)}" target="_blank" rel="noopener">Compare on GitHub ${ICONS.ext}</a>`
    : d.compareUrlRaw
      ? `<span class="muted">${esc(d.compareUrlRaw)} (not linked: failed redaction check)</span>`
      : `<span class="muted">—</span>`;
  const triage = d.triage
    ? `${esc(d.triage.verdict)}${d.triage.confidence != null ? ` · ${Math.round(d.triage.confidence * 100)}%` : ""}${d.triage.legacy ? ` <span class="muted">(derived from class/fixable)</span>` : ""}`
    : `<span class="muted">—</span>`;
  const mv = moveForm(base, d, caps);
  return `<div class="dr" data-drawer-id="${d.id}">
    <header class="dr-h">
      <div>
        <p class="dr-kicker"><span class="chip st st-${esc(d.status)}">${esc(d.statusLabel)}</span>
          <span class="chip sev ${sevCls}">${esc(d.severity || "n/a")}</span><span class="chip cls">${esc(d.klass)}</span></p>
        <h2 id="drawer-title">#${d.id} <span>${esc(d.summary)}</span></h2>
      </div>
      <a class="dr-close" href="${esc(`${base}/`)}" data-close aria-label="Close details">${ICONS.close}</a>
    </header>
    <div class="dr-body">
      ${reasons}
      ${actions || mv ? `<div class="dr-actions">${actions}${mv}</div>` : ""}
      <section><h3>Summary</h3><p>${esc(d.summaryFull)}</p></section>
      <dl class="dr-kv">
        ${kv("Unit", esc(d.unit || "—"))}
        ${kv("Target repo", `<code>${esc(d.repo)}</code>`)}
        ${kv("Neo version", esc(d.neoVersion || "—"))}
        ${kv("Report hash", `<code>${esc(d.reportHash)}…</code>`)}
        ${kv("Created", `${esc(d.created)} <span class="muted">Zurich</span>`)}
        ${kv("Updated", `${esc(d.updated)} <span class="muted">Zurich</span>`)}
        ${kv("Triage verdict", triage)}
        ${kv("Lab test", d.lab ? `<span class="chip lab-${esc(d.lab)}">${esc(d.lab)}</span>` : `<span class="muted">no result</span>`)}
        ${kv("Draft branch", d.branch ? `<code>${esc(d.branch)}</code>` : `<span class="muted">—</span>`)}
        ${kv("Compare / PR", `${compare}${d.pr?.url ? ` · <a href="${esc(d.pr.url)}" target="_blank" rel="noopener">PR #${esc(d.pr.number)} ${ICONS.ext}</a>` : d.draftPrUrl ? ` · <a href="${esc(d.draftPrUrl)}" target="_blank" rel="noopener">PR ${ICONS.ext}</a>` : ""}`)}
        ${d.pr ? kv("PR loop", `<span class="chip pr-st">${esc(d.pr.label)}</span>${d.pr.draft && d.pr.state === "open" ? " · draft" : ""}${d.pr.maxRounds ? ` · round ${esc(d.pr.round)}/${esc(d.pr.maxRounds)}` : ""}${d.pr.revisePending ? " · revision running" : ""}${d.pr.stopped ? " · automation stopped" : ""}${d.pr.halted ? ` · halted (${esc(String(d.pr.halted).replace(/_/g, " "))})` : ""} · last reviewer comment ${d.pr.lastFeedback ? `${esc(d.pr.lastFeedback)} <span class="muted">Zurich</span>` : `<span class="muted">none</span>`}`) : ""}
      </dl>
      ${d.labRun ? renderLabReport(d.labRun) : d.labSummary ? `<section><h3>Lab-test result</h3><p class="mono">${esc(d.labSummary)}</p></section>` : ""}
      <section><h3>Fix attempts <span class="muted">(${d.attemptsTable.length})</span></h3>${attempts}</section>
      <section><h3>Events <span class="muted">newest first · Europe/Zurich</span></h3>${events}</section>
      ${d.logsExcerpt ? `<details class="dr-logs"><summary>Logs excerpt (redacted)</summary><pre>${esc(d.logsExcerpt)}</pre></details>` : ""}
      <p class="dr-foot muted"><a href="${esc(`${base}/incidents/${d.id}`)}">Full record / edit class &amp; target</a> (unredacted staff view)</p>
    </div>
  </div>`;
}
