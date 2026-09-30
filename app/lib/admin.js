/**
 * Admin UI — kanban board of incidents (drag/drop status, human-input
 * badges, drawer), per-incident staff page, Start triage / Start fix /
 * Retry push. Edge auth: Tinyauth via SWAG (admin.auth). In-app:
 * ADMIN_ENABLED / ADMIN_READ_ONLY, same-origin check on every POST.
 */
import express, { Router } from "express";
import { adminLayout, escapeHtml } from "./layout.js";
import {
  checkTransition,
  parseFilters,
  STATUS_LABELS,
  TRANSITIONS,
  makeDisplayRedactor,
} from "./board.js";
import { buildCardModel, buildDrawerModel, renderBoard, renderCard, renderDrawer } from "./board-view.js";
import { mergeKnownSlugs, getExtraRedactSlugs } from "./redact.js";
import {
  getDb,
  listIncidents,
  getIncident,
  listIncidentEvents,
  updateIncident,
  addIncidentEvent,
  countByStatus,
  getClasses,
  getStatuses,
  listFixAttempts,
  getLatestIncidentEvent,
  listDistinctCustomerRepoSlugs,
  listEventsForIncidents,
  listFixAttemptsForIncidents,
} from "./db.js";
import {
  enqueueJob,
  enqueuePushJob,
  isAutofixKindEnabled,
  getForkPushTokenState,
  NO_TOKEN_WARNING,
} from "./queue.js";
import { ingestResultsDir, pushRetryJob } from "./results.js";
import { registerQueueRoutes } from "./admin-queue.js";
import { workerModel, queueModel } from "./worker-state.js";
import { renderWorkerPanel } from "./worker-view.js";
import { currentRevision, encodeRev } from "./live.js";
import {
  getAllowlist,
  isRepoAllowed,
  resolveTargetRepo,
} from "./github.js";

const ADMIN_ENABLED = !["false", "0", "no", "off"].includes(
  String(process.env.ADMIN_ENABLED ?? "true").toLowerCase(),
);
const ADMIN_PATH = (process.env.ADMIN_PATH || "/admin").replace(/\/$/, "") || "/admin";
const ADMIN_READ_ONLY = ["true", "1", "yes", "on"].includes(
  String(process.env.ADMIN_READ_ONLY || "false").toLowerCase(),
);

function flash(q) {
  const msg = q && q.msg ? String(q.msg) : "";
  const err = q && q.err ? String(q.err) : "";
  if (err) return `<div class="alert warn">${escapeHtml(err)}</div>`;
  if (msg) return `<div class="alert ok">${escapeHtml(msg)}</div>`;
  return "";
}

function readOnlyBanner() {
  if (!ADMIN_READ_ONLY) return "";
  return `<div class="alert warn"><strong>Read-only.</strong> Mutating actions are disabled (ADMIN_READ_ONLY).</div>`;
}

function table(headers, rowsHtml) {
  return `<div class="card" style="overflow-x:auto">
    <table class="admin-table">
      <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${rowsHtml || `<tr><td colspan="${headers.length}" class="muted">None</td></tr>`}</tbody>
    </table>
  </div>`;
}

function refuseMutations(res, base) {
  if (ADMIN_READ_ONLY) {
    res.status(403).type("html").send(
      adminLayout({
        title: "Read-only",
        basePath: base,
        readOnly: true,
        body: `${readOnlyBanner()}<p><a href="${base}/">Back</a></p>`,
      }),
    );
    return true;
  }
  return false;
}

export function createAdminRouter() {
  const router = Router();

  router.use((req, res, next) => {
    if (!ADMIN_ENABLED) {
      return res.status(404).type("html").send("Not found");
    }
    const mount = req.baseUrl || ADMIN_PATH;
    req.adminBase = mount.replace(/\/$/, "") || ADMIN_PATH;
    next();
  });

  router.use(express.urlencoded({ extended: true }));
  router.use(express.json({ limit: "16kb" }));

  // Same-origin guard on every mutating request (edge auth is cookie based).
  router.post("*", (req, res, next) => {
    if (isSameOrigin(req)) return next();
    const msg = "Cross-origin request refused.";
    if (wantsJson(req)) return res.status(403).json({ ok: false, error: "cross_origin", message: msg });
    return res.status(403).type("text").send(msg);
  });

  router.get("/", (req, res) => {
    safeIngest();
    const base = req.adminBase;
    const filters = parseFilters(req.query);
    const caps = capabilities();
    const redact = displayRedactor();
    const w = workerModel({ redact, caps });
    const q = queueModel({ redact, caps, worker: w });
    const rev = encodeRev(currentRevision());
    const { cards, counts } = boardData();
    res.type("html").send(
      adminLayout({
        title: "Incidents",
        basePath: base,
        readOnly: ADMIN_READ_ONLY,
        wide: true,
        head: `<link rel="stylesheet" href="/css/board.css" />`,
        body: renderBoard({
          cards,
          counts,
          filters,
          base,
          caps: { ...caps, runningJob: w.job },
          status: { token: tokenLabel(), allowlist: getAllowlist() },
          flash: `${readOnlyBanner()}${flash(req.query)}`,
          panel: renderWorkerPanel(w, q, { base, caps, variant: "board" }),
          rev,
        }),
      }),
    );
  });

  // Board data as JSON (redacted view models only; used by tests/tools).
  router.get("/board.json", (req, res) => {
    safeIngest();
    const { cards, counts } = boardData();
    res.json({
      readOnly: ADMIN_READ_ONLY,
      transitions: TRANSITIONS,
      counts,
      cards,
    });
  });

  router.get("/incidents/:id/drawer.json", (req, res) => {
    const d = drawerModel(Number(req.params.id));
    if (!d) return res.status(404).json({ ok: false, error: "not_found" });
    return res.json({ ok: true, incident: d });
  });

  // Drawer fragment (board JS) or a standalone page (no-JS link from the card).
  router.get("/incidents/:id/drawer", (req, res) => {
    safeIngest();
    const base = req.adminBase;
    const d = drawerModel(Number(req.params.id));
    if (!d) return res.status(404).send("Not found");
    const html = renderDrawer(d, base, capabilities());
    if (req.query.fragment) return res.type("html").send(html);
    return res.type("html").send(
      adminLayout({
        title: `Incident #${d.id}`,
        basePath: base,
        readOnly: ADMIN_READ_ONLY,
        wide: true,
        head: `<link rel="stylesheet" href="/css/board.css" />`,
        body: `<div class="board-wrap drawer-page">${readOnlyBanner()}${flash(req.query)}<p><a href="${base}/#incident-${d.id}">← Board</a></p><div class="drawer static">${html}</div></div>`,
      }),
    );
  });

  router.get("/incidents/:id", (req, res) => {
    try {
      ingestResultsDir();
    } catch (err) {
      console.error("[admin] ingestResultsDir", err);
    }
    const id = Number(req.params.id);
    const incident = getIncident(id);
    if (!incident) return res.status(404).send("Not found");
    const events = listIncidentEvents(id);
    const base = req.adminBase;
    const resolved = resolveTargetRepo(incident);
    const classOptions = getClasses()
      .map(
        (c) =>
          `<option value="${c}" ${incident.class === c ? "selected" : ""}>${c}</option>`,
      )
      .join("");
    const statusOptions = getStatuses()
      .filter((s) => s === incident.status || (TRANSITIONS[incident.status] || []).includes(s))
      .map(
        (s) =>
          `<option value="${s}" ${incident.status === s ? "selected" : ""}>${s}</option>`,
      )
      .join("");

    const eventRows = events
      .map(
        (e) => `<tr>
          <td class="muted">#${e.id}</td>
          <td><code>${escapeHtml(e.kind)}</code></td>
          <td>${escapeHtml(e.message || "")}</td>
          <td class="muted">${escapeHtml(e.created_at || "")}</td>
        </tr>`,
      )
      .join("");

    const mutate =
      ADMIN_READ_ONLY
        ? `<p class="muted">Mutations disabled (read-only).</p>`
        : `
        <form method="post" action="${base}/incidents/${id}" class="card">
          <input type="hidden" name="_action" value="update" />
          <label>Class</label>
          <select name="class">${classOptions}</select>
          <label>Status</label>
          <select name="status">${statusOptions}</select>
          <label>Target repo (must be allowlisted)</label>
          <input name="target_repo" value="${escapeHtml(incident.target_repo || incident.target_hint || resolved)}" placeholder="owner/repo" />
          <p style="margin-top:1rem"><button class="btn" type="submit">Save</button></p>
        </form>
        ${
          isAutofixKindEnabled("triage")
            ? `<form method="post" action="${base}/incidents/${id}/start-triage" class="card">
          <p><strong>Start triage</strong> enqueues a host-side triage job (local Hermes classifies the incident; no code push).</p>
          <button class="btn secondary" type="submit">Start triage</button>
        </form>`
            : ""
        }
        ${(() => {
          const job = isAutofixKindEnabled("push") ? pushRetryJob(incident, getLatestIncidentEvent(id, "fix_result")) : null;
          return job
            ? `<form method="post" action="${base}/incidents/${id}/retry-push" class="card" onsubmit="return confirm('Retry pushing the saved fix for incident #${id}?');">
          <input type="hidden" name="job" value="${escapeHtml(job)}" />
          <p><strong>Retry push</strong> pushes the fix already committed on the host (job <code>${escapeHtml(job)}</code>) to the fork,
             re-runs the gates and the lab test, and prepares the compare link. No new Hermes run; does not use a fix attempt.</p>
          <button class="btn" type="submit">Retry push</button>
        </form>`
            : "";
        })()}
        ${
          isAutofixKindEnabled("fix")
            ? `<form method="post" action="${base}/incidents/${id}/start-fix" class="card" onsubmit="return confirm('Enqueue fix job for incident #${id}?');">
          <p><strong>Start fix</strong> enqueues a host-side fix job (status → fixing). The worker runs local Hermes, pushes a fork branch, and prepares a compare link.
             Resolved target: <code>${escapeHtml(resolved)}</code>. No auto-merge.</p>
          ${(() => {
            const t = getForkPushTokenState();
            return t.known && !t.ok
              ? `<div class="alert warn">${escapeHtml(NO_TOKEN_WARNING)}${t.checked_at ? ` <span class="muted">(worker check ${escapeHtml(t.checked_at)})</span>` : ""}</div>`
              : "";
          })()}
          <button class="btn" type="submit">Start fix</button>`
            : `<div class="card">
          <p><strong>Start fix unavailable:</strong> autofix is not enabled on this host
             (<code>neo.services.ops.autofix.enable</code> + <code>autofix.fix.enable</code>), so no worker would pick up the job.</p>`
        }
          ${
            incident.draft_pr_url
              ? `<p style="margin-top:0.75rem" class="muted">Legacy draft PR link: <a href="${escapeHtml(incident.draft_pr_url)}" target="_blank" rel="noopener">${escapeHtml(incident.draft_pr_url)}</a></p>`
              : ""
          }
        ${isAutofixKindEnabled("fix") ? "</form>" : "</div>"}`;

    res.type("html").send(
      adminLayout({
        title: `Incident #${id}`,
        basePath: base,
        readOnly: ADMIN_READ_ONLY,
        body: `
        <h1>Incident #${id}</h1>
        ${readOnlyBanner()}
        ${flash(req.query)}
        <div class="card">
          <p><strong>report_hash:</strong> <code>${escapeHtml(incident.report_hash)}</code></p>
          <p><strong>severity:</strong> ${escapeHtml(incident.severity || "—")}
             · <strong>status:</strong> ${escapeHtml(incident.status)}
             · <strong>class:</strong> ${escapeHtml(incident.class)}</p>
          <p><strong>neo_version:</strong> ${escapeHtml(incident.neo_version || "—")}
             · <strong>unit:</strong> ${escapeHtml(incident.unit || "—")}</p>
          <p><strong>customer_repo_slug:</strong> <code>${escapeHtml(incident.customer_repo_slug || "—")}</code></p>
          <p><strong>target_hint / target_repo:</strong>
             <code>${escapeHtml(incident.target_hint || "—")}</code> /
             <code>${escapeHtml(incident.target_repo || "—")}</code>
             → resolved <code>${escapeHtml(resolved)}</code>
             ${isRepoAllowed(resolved) ? "" : " <span class=\"alert warn\">not allowlisted</span>"}</p>
          <p class="muted">Created ${escapeHtml(incident.created_at || "")} · Updated ${escapeHtml(incident.updated_at || "")}</p>
        </div>
        <div class="card">
          <h2>Plugin URLs</h2>
          <pre style="white-space:pre-wrap;font-size:0.85rem">${escapeHtml(incident.plugin_urls || "—")}</pre>
        </div>
        <div class="card">
          <h2>Logs excerpt</h2>
          <pre style="white-space:pre-wrap;font-size:0.85rem">${escapeHtml(incident.logs_excerpt || "—")}</pre>
        </div>
        ${
          incident.compare_url || incident.prepared_pr_title || incident.draft_branch
            ? `<div class="card">
          <h2>Prepared fix (compare-link fallback)</h2>
          <p><strong>branch:</strong> <code>${escapeHtml(incident.draft_branch || "—")}</code></p>
          <p><strong>compare:</strong> ${
            incident.compare_url
              ? `<a href="${escapeHtml(incident.compare_url)}" target="_blank" rel="noopener">${escapeHtml(incident.compare_url)}</a>`
              : "—"
          }</p>
          <p><strong>title:</strong> ${escapeHtml(incident.prepared_pr_title || "—")}</p>
          <pre style="white-space:pre-wrap;font-size:0.85rem">${escapeHtml(incident.prepared_pr_body || "")}</pre>
        </div>`
            : ""
        }
        ${(() => {
          const attempts = listFixAttempts(id);
          if (!attempts.length) return "";
          const rows = attempts.map((a) => `<tr>
            <td>${a.attempt}</td>
            <td><code>${escapeHtml(a.branch || "—")}</code></td>
            <td>${escapeHtml(a.result || "—")}</td>
            <td class="muted">${escapeHtml(a.created_at || "")}</td>
          </tr>`).join("");
          return `<h2>Fix attempts</h2>${table(["#", "Branch", "Result", "Created"], rows)}`;
        })()}
        ${mutate}
        <h2>Events</h2>
        ${table(["ID", "Kind", "Message", "Created"], eventRows)}
        <p><a href="${base}/">← Incidents</a></p>
        `,
      }),
    );
  });

  // The admin update path: legacy form (class/status/target), board forms
  // (_action=move|mark_config_error|mark_resolved|close) and the JSON variant
  // (Content-Type: application/json) used by drag and drop.
  router.post("/incidents/:id", (req, res) => {
    const base = req.adminBase;
    const json = wantsJson(req);
    const id = Number(req.params.id);
    if (ADMIN_READ_ONLY) {
      if (json) return res.status(403).json({ ok: false, error: "read_only", message: "Admin is read-only (ADMIN_READ_ONLY)." });
      return refuseMutations(res, base);
    }
    try {
      const out = applyAdminUpdate(id, req.body || {});
      if (!out) {
        return json ? res.status(404).json({ ok: false, error: "not_found", message: `Incident #${id} not found.` }) : res.status(404).send("Not found");
      }
      if (json) return res.json({ ok: true, message: out.message, ...cardPayload(id, base), event: { id: out.event.id, kind: out.event.kind, message: out.event.message } });
      return res.redirect(303, backTo(req, base, id, "msg", out.status === "update" ? "Incident updated" : out.message));
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error("[admin] update", err);
      const message = err.message || "Update failed";
      if (json) return res.status(status).json({ ok: false, error: err.code || "update_failed", message, ...cardPayload(id, base) });
      return res.redirect(303, backTo(req, base, id, "err", message));
    }
  });

  function enqueueHandler(kind) {
    return (req, res) => {
      const base = req.adminBase;
      const json = wantsJson(req);
      if (ADMIN_READ_ONLY && json) return res.status(403).json({ ok: false, error: "read_only", message: "Admin is read-only (ADMIN_READ_ONLY)." });
      if (refuseMutations(res, base)) return;
      const id = Number(req.params.id);
      const incident = getIncident(id);
      if (!incident) return json ? res.status(404).json({ ok: false, error: "not_found" }) : res.status(404).send("Not found");
      try {
        const resolved = resolveTargetRepo(incident);
        const { path: jobPath, job } = enqueueJob(kind, incident);
        const patch = { target_repo: incident.target_repo || resolved };
        if (kind === "fix") patch.status = "fixing";
        const updated = updateIncident(id, patch);
        addIncidentEvent(id, `${kind}_enqueued`, `${kind === "fix" ? "Fix" : "Triage"} job enqueued for host worker`, {
          target_repo: updated.target_repo,
          job_file: jobPath.split("/").pop(),
          job_kind: job.kind,
        });
        const t = kind === "fix" ? getForkPushTokenState() : { known: false };
        const msg =
          t.known && !t.ok
            ? `Fix job enqueued. ${NO_TOKEN_WARNING}`
            : `${kind === "fix" ? "Fix" : "Triage"} job enqueued`;
        if (json) return res.json({ ok: true, message: msg, ...cardPayload(id, base) });
        return res.redirect(303, backTo(req, base, id, "msg", msg));
      } catch (err) {
        console.error(`[admin] start-${kind}`, err.code || "", err.message);
        const message = err.message || `Start ${kind} failed`;
        if (json) return res.status(err.status || 500).json({ ok: false, error: err.code || "enqueue_failed", message, ...cardPayload(id, base) });
        return res.redirect(303, backTo(req, base, id, "err", message));
      }
    };
  }

  router.post("/incidents/:id/start-fix", enqueueHandler("fix"));
  router.post("/incidents/:id/retry-push", (req, res) => {
    const base = req.adminBase;
    const json = wantsJson(req);
    if (ADMIN_READ_ONLY && json) return res.status(403).json({ ok: false, error: "read_only", message: "Admin is read-only (ADMIN_READ_ONLY)." });
    if (refuseMutations(res, base)) return;
    const id = Number(req.params.id);
    const incident = getIncident(id);
    if (!incident) return json ? res.status(404).json({ ok: false, error: "not_found" }) : res.status(404).send("Not found");
    try {
      // Job name comes from the DB, never from the form (form value is display only).
      const job = pushRetryJob(incident, getLatestIncidentEvent(id, "fix_result"));
      if (!job) throw new Error(`Incident #${id} has no saved fix waiting for a push.`);
      const { path: jobPath } = enqueuePushJob(incident, job);
      addIncidentEvent(id, "push_enqueued", `Push retry enqueued for saved fix ${job} (no Hermes run)`, {
        job,
        job_file: jobPath.split("/").pop(),
        job_kind: "push",
      });
      if (json) return res.json({ ok: true, message: "Push retry enqueued", ...cardPayload(id, base) });
      return res.redirect(303, backTo(req, base, id, "msg", "Push retry enqueued"));
    } catch (err) {
      console.error("[admin] retry-push", err.code || "", err.message);
      const message = err.message || "Retry push failed";
      if (json) return res.status(err.status || 500).json({ ok: false, error: err.code || "retry_push_failed", message, ...cardPayload(id, base) });
      return res.redirect(303, backTo(req, base, id, "err", message));
    }
  });
  router.post("/incidents/:id/start-triage", enqueueHandler("triage"));

  registerQueueRoutes(router, {
    readOnly: ADMIN_READ_ONLY,
    capabilities,
    displayRedactor,
    cardsFor,
    wantsJson,
    flash,
    readOnlyBanner,
  });

  // Silence unused import warning for getDb if tree-shaken oddly — keep for parity / future
  void getDb;

  return router;
}

// ------------------------------------------------------------ board helpers

function safeIngest() {
  try {
    ingestResultsDir();
  } catch (err) {
    console.error("[admin] ingestResultsDir", err);
  }
}

export function wantsJson(req) {
  return Boolean(req.is("application/json")) || /\bapplication\/json\b/.test(String(req.get("accept") || ""));
}

/**
 * CSRF guard. Browsers send Sec-Fetch-Site on every request: only
 * same-origin (or a user-typed "none") may mutate. Without it (older
 * browsers, curl), an Origin header must match the forwarded/Host header.
 * No Origin at all = non-browser client; edge auth still applies.
 */
export function isSameOrigin(req) {
  const site = String(req.get("sec-fetch-site") || "").toLowerCase();
  if (site) return site === "same-origin" || site === "none";
  const origin = req.get("origin");
  if (!origin) return true;
  try {
    const host = String(req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim().toLowerCase();
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function capabilities() {
  return {
    readOnly: ADMIN_READ_ONLY,
    triage: isAutofixKindEnabled("triage"),
    fix: isAutofixKindEnabled("fix"),
    push: isAutofixKindEnabled("push"),
  };
}

function tokenLabel() {
  const t = getForkPushTokenState();
  if (!t.known) return "unknown";
  return t.ok ? "ok" : "missing";
}

/** Display redactor: DB slugs + OPS_REDACT_EXTRA_SLUGS (fresh per request). */
function displayRedactor() {
  return makeDisplayRedactor(mergeKnownSlugs(listDistinctCustomerRepoSlugs(), ...getExtraRedactSlugs()));
}

function boardData() {
  const incidents = listIncidents({ limit: 500 });
  const ids = incidents.map((i) => i.id);
  const events = listEventsForIncidents(ids);
  const attempts = listFixAttemptsForIncidents(ids);
  const redact = displayRedactor();
  const now = new Date();
  const cards = incidents.map((i) => buildCardModel(i, events.get(i.id) || [], attempts.get(i.id) || [], redact, { now }));
  return { cards, counts: countByStatus() };
}

function drawerModel(id) {
  const incident = getIncident(id);
  if (!incident) return null;
  return buildDrawerModel(incident, listIncidentEvents(id, { limit: 500 }), listFixAttempts(id), displayRedactor());
}

function runningCaps() {
  const caps = capabilities();
  try {
    return { ...caps, runningJob: workerModel({ caps }).job };
  } catch {
    return caps;
  }
}

function cardPayload(id, base) {
  const incident = getIncident(id);
  if (!incident) return {};
  const card = buildCardModel(incident, listIncidentEvents(id, { limit: 500 }), listFixAttempts(id), displayRedactor());
  return { incident: { id: card.id, status: card.status, class: card.klass }, card, card_html: renderCard(card, base, runningCaps()) };
}

/** Rendered cards for live patches: { cards: [{id, status, column, needed, html}], need_total }. */
function cardsFor(ids, base, caps) {
  const all = ids === "all";
  const incidents = all ? listIncidents({ limit: 500 }) : ids.map((id) => getIncident(id)).filter(Boolean);
  const list = incidents.map((i) => i.id);
  const events = listEventsForIncidents(list);
  const attempts = listFixAttemptsForIncidents(list);
  const redact = displayRedactor();
  const now = new Date();
  const cards = incidents.map((i) => {
    const c = buildCardModel(i, events.get(i.id) || [], attempts.get(i.id) || [], redact, { now });
    return { id: c.id, status: c.status, column: c.column, needed: c.needed, html: renderCard(c, base, caps) };
  });
  return { cards, full: all };
}

/** Redirect target: board (return_to=board) or the staff incident page. */
function backTo(req, base, id, key, text) {
  const q = `${key}=${encodeURIComponent(text)}`;
  if (String(req.body?.return_to || "") === "board") return `${base}/?${q}#incident-${id}`;
  return `${base}/incidents/${id}?${q}`;
}

const BOARD_ACTIONS = {
  mark_config_error: { status: "closed", class: "human_config", note: "marked as config error" },
  mark_resolved: { status: "resolved", note: "marked resolved" },
  close: { status: "closed", note: "closed" },
};

function has(body, k) {
  return Object.hasOwn(body, k) && body[k] != null;
}

/**
 * Apply one admin update and always record an admin_update event.
 * Status changes go through the transition table (409 on refusal).
 * @returns {null | { status: string, message: string, event: object, incident: object }}
 */
export function applyAdminUpdate(id, body) {
  const incident = getIncident(id);
  if (!incident) return null;
  const action = String(body._action || body.action || "update").trim();
  const patch = {};
  let note = null;
  if (Object.hasOwn(BOARD_ACTIONS, action)) {
    const a = BOARD_ACTIONS[action];
    patch.status = a.status;
    if (a.class) patch.class = a.class;
    note = a.note;
  } else if (action === "update" || action === "move") {
    const st = has(body, "status") ? String(body.status).trim() : "";
    const cl = has(body, "class") ? String(body.class).trim() : "";
    if (st) patch.status = st;
    if (cl) patch.class = cl;
    if (action === "update" && has(body, "target_repo")) patch.target_repo = String(body.target_repo).trim() || null;
    if (action === "move" && !st) throw Object.assign(new Error("Pick a target status."), { status: 400, code: "status_required" });
  } else {
    throw Object.assign(new Error(`Unknown action "${action}".`), { status: 400, code: "invalid_action" });
  }
  const from = incident.status;
  const expect = has(body, "expect_from") ? String(body.expect_from).trim() : "";
  if (expect && expect !== from) {
    throw Object.assign(new Error(`Incident #${id} is now ${STATUS_LABELS[from] || from} (changed elsewhere); reloaded.`), {
      status: 409,
      code: "stale_status",
    });
  }
  const to = patch.status ?? from;
  if (to !== from) {
    const t = checkTransition(from, to);
    if (!t.ok) throw Object.assign(new Error(t.message), { status: t.code === "invalid_status" ? 400 : 409, code: t.code });
  }
  const updated = updateIncident(id, patch);
  const statusMsg = to !== from ? `status ${from} -> ${to}` : "Class/status/target updated";
  const message = note ? `${statusMsg} (${note})` : statusMsg;
  const event = addIncidentEvent(id, "admin_update", message, {
    from,
    to,
    action,
    ...(note ? { note } : {}),
    class: updated.class,
    status: updated.status,
    target_repo: updated.target_repo,
  });
  return { status: action === "update" ? "update" : "ok", message, event, incident: updated };
}

export function getAdminConfig() {
  return { ADMIN_ENABLED, ADMIN_PATH, ADMIN_READ_ONLY };
}
