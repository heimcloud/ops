/**
 * Worker state panel (board strip + queue page) and the queue view.
 * Models come from worker-state.js with free text already redacted; this
 * module only escapes. No job file content besides validated names/ids.
 */
import { escapeHtml } from "./layout.js";
import { durationLabel, agoLabel } from "./worker-state.js";

const esc = (s) => escapeHtml(s == null ? "" : s);

const I = {
  pause: `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4 2.5h2.6v11H4zm5.4 0H12v11H9.4z"/></svg>`,
  play: `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4.5 2.3 13.2 8l-8.7 5.7z"/></svg>`,
  up: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 3.2 13.4 9l-1.2 1.1L8 5.6l-4.2 4.5L2.6 9z"/></svg>`,
  down: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 12.8 2.6 7l1.2-1.1L8 10.4l4.2-4.5L13.4 7z"/></svg>`,
  top: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M2.5 2h11v1.6h-11zM8 5.2l5.4 5.8-1.2 1.1L8 7.6l-4.2 4.5L2.6 11z"/></svg>`,
  x: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3.7 2.3 8 6.6l4.3-4.3 1.4 1.4L9.4 8l4.3 4.3-1.4 1.4L8 9.4l-4.3 4.3-1.4-1.4L6.6 8 2.3 3.7z"/></svg>`,
  retry: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 2.2a5.8 5.8 0 0 1 5.3 3.4l1-.6.4 4-3.6-1.8 1-.6A4.2 4.2 0 1 0 12.2 9h1.6A5.8 5.8 0 1 1 8 2.2Z"/></svg>`,
  ok: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="m6.4 10.6 6.3-6.3 1.1 1.1-7.4 7.4-4.2-4.2 1.1-1.1z"/></svg>`,
  bad: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3.7 2.3 8 6.6l4.3-4.3 1.4 1.4L9.4 8l4.3 4.3-1.4 1.4L8 9.4l-4.3 4.3-1.4-1.4L6.6 8 2.3 3.7z"/></svg>`,
  warn: `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 1.2a1 1 0 0 1 .87.5l6.3 11a1 1 0 0 1-.87 1.5H1.7a1 1 0 0 1-.87-1.5l6.3-11A1 1 0 0 1 8 1.2Zm0 4a.8.8 0 0 0-.8.8v3.2a.8.8 0 0 0 1.6 0V6a.8.8 0 0 0-.8-.8Zm0 6.1a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z"/></svg>`,
};

const STATE_TEXT = {
  running: "Running",
  idle: "Idle",
  paused: "Paused",
  stale: "Stale",
  unknown: "Not reporting",
  off: "Autofix off",
};

function stateTitle(w) {
  if (w.display === "stale") return `Worker says running but its heartbeat is ${durationLabel(w.heartbeatAgeSec) || "missing"} old (stale after ${durationLabel(w.staleAfterSec)}).`;
  if (w.display === "unknown") return "No worker-status.json v2 yet (worker not upgraded or never ran).";
  if (w.display === "paused") return "Queue paused: the worker finishes the current job, then claims nothing new.";
  return "";
}

export function liveIndicator() {
  return `<span class="live" data-live data-state="connecting" role="status" aria-live="polite" title="Live updates"><i class="dot" aria-hidden="true"></i><span data-live-text>Connecting…</span></span>`;
}

function hiddenFields(fields) {
  return Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}" />`)
    .join("");
}

/** POST form enhanced by JS (data-qaction): JSON fetch + live refresh. */
function actionButton(base, action, label, fields, { cls = "", icon = "", title = "", confirm = "", ro = false } = {}) {
  if (ro) return "";
  return `<form class="qform" method="post" action="${esc(`${base}/queue/${action}`)}" data-qaction="${esc(action)}"${confirm ? ` data-confirm="${esc(confirm)}"` : ""}>${hiddenFields(fields)}<button class="kbtn ${cls}" type="submit"${title ? ` title="${esc(title)}" aria-label="${esc(title)}"` : ""}>${icon}${label ? `<span>${esc(label)}</span>` : ""}</button></form>`;
}

function pauseButton(base, w, q, returnTo, ro) {
  if (ro || !w.enabled) return "";
  return q.paused
    ? actionButton(base, "resume", "Resume queue", { return_to: returnTo }, { cls: "primary", icon: I.play })
    : actionButton(base, "pause", "Pause queue", { return_to: returnTo }, { icon: I.pause, title: "Pause: finish the running job, claim nothing new" });
}

function tick(ok, yes, no) {
  return ok ? `<span class="okv">${I.ok}${esc(yes)}</span>` : `<span class="badv">${I.bad}${esc(no)}</span>`;
}

function incLink(base, id, onBoard) {
  if (!id) return "";
  return onBoard
    ? `<a href="${esc(`${base}/incidents/${id}/drawer`)}" data-open="${id}">#${id}</a>`
    : `<a href="${esc(`${base}/#incident-${id}`)}">#${id}</a>`;
}

function jobLine(base, w, onBoard) {
  const j = w.job;
  if (!j) {
    if (w.display === "paused") return `<span class="wp-job muted">Paused${w.paused?.atLabel ? ` since ${esc(w.paused.atLabel)}` : ""} — no new jobs are claimed.</span>`;
    if (w.display === "off") return `<span class="wp-job muted">Autofix is not enabled on this host.</span>`;
    if (w.display === "unknown") return `<span class="wp-job muted">No heartbeat from the host worker yet.</span>`;
    return `<span class="wp-job muted">Waiting for jobs.</span>`;
  }
  return `<span class="wp-job"><span class="chip kind k-${esc(j.kind)}">${esc(j.kind)}</span> ${incLink(base, j.incidentId, onBoard)} · <b class="wp-stage" data-stage="${esc(j.stage)}">${esc(j.stageText)}</b> · since ${esc(j.startedLabel)} · <span class="mono" data-elapsed-from="${j.startedAt || ""}">${esc(durationLabel(j.elapsedSec))}</span>${j.claims > 1 ? ` · <span class="warnv" title="Second claim after a crashed run">claim ${j.claims}</span>` : ""}${j.cancelRequested ? ` · <span class="warnv">cancel requested</span>` : ""}</span>`;
}

function lastRunText(base, w, onBoard) {
  const r = w.lastRun;
  if (!r) return `<span class="muted">none yet</span>`;
  const cls = r.ok && !/failed|blocked|denied|needs_human/.test(r.status) ? "ok" : r.reason === "cancelled" || /cancelled/.test(r.status) ? "muted" : "bad";
  return `<span class="chip st ${cls}" title="${esc(r.summary)}">${esc(r.status.replace(/_/g, " "))}</span> ${esc(r.kind)} ${incLink(base, r.incidentId, onBoard)} · ${esc(r.finishedLabel)}`;
}

function systemdText(w, full) {
  const s = w.systemd;
  if (!s.present) return `<span class="muted" title="queue/systemd-status.json is written by heimcloud-ops-worker-kick.timer on the host">no host report</span>`;
  const unit = (name, u) => `${u.ok ? `<span class="okv">${I.ok}` : `<span class="badv">${I.bad}`}${esc(name)}${u.ok && !full ? "" : ` ${esc(u.label)}`}</span>`;
  const staleBit = s.stale ? ` <span class="warnv" title="Kick timer report is older than 15 min">stale report</span>` : "";
  const acted = full && s.lastActions.length
    ? `<div class="muted small">Last watchdog action ${esc(s.lastActionLabel)}: ${esc(s.lastActions.map((a) => `${a.action} ${a.units.map((u) => u.replace("heimcloud-ops-worker", "worker")).join(" ")}${a.ok ? "" : " (failed)"}`).join("; "))}</div>`
    : "";
  return `${unit("path", s.path)} ${unit("service", s.service)}${full ? ` <span class="muted small">as of ${esc(s.checkedLabel)}</span>` : ""}${staleBit}${acted}`;
}

function minutes(sec) {
  if (!sec) return "n/a";
  return sec % 60 === 0 ? `${sec / 60} min` : durationLabel(sec);
}

function issueList(base, w, onBoard, max) {
  if (!w.issues.length) return "";
  const list = w.issues.slice(0, max);
  return `<ul class="wp-issues">${list
    .map(
      (i) => `<li class="iss iss-${esc(i.code)}">${I.warn}<b>${esc(i.label)}</b><span class="iss-msg">${esc(i.message)}</span><span class="muted">${i.incidentId ? `${incLink(base, i.incidentId, onBoard)} · ` : ""}${esc(i.atLabel)}</span></li>`,
    )
    .join("")
    .replace(/<\/li>$/, w.issues.length > max ? `<a class="iss-more" href="${esc(`${base}/queue`)}">+${w.issues.length - max} more</a></li>` : "</li>")}</ul>`;
}

/**
 * @param {object} w workerModel()
 * @param {object} q queueModel()
 * @param {{ base: string, caps: object, variant?: "board"|"full" }} opts
 */
export function renderWorkerPanel(w, q, { base, caps, variant = "board" }) {
  const full = variant === "full";
  const onBoard = !full;
  const ro = Boolean(caps.readOnly);
  const returnTo = full ? "queue" : "board";
  const state = w.display;
  const counts = q.counts;
  const queueBits = [
    `${counts.pending} pending`,
    counts.processing ? `${counts.processing} running` : "",
    counts.failed24h ? `<span class="badv">${counts.failed24h} failed (24h)</span>` : "",
  ].filter(Boolean);
  const cancelRunning =
    full && w.job && w.job.processing && !w.job.cancelRequested
      ? actionButton(base, "cancel-running", "Cancel running job", { job: w.job.processing, return_to: returnTo }, {
          cls: "danger",
          icon: I.x,
          ro,
          confirm: `Cancel the running ${w.job.kind} job for #${w.job.incidentId}? Hermes is stopped at the next checkpoint (its process group gets SIGTERM).`,
        })
      : "";
  const facts = [
    ["Last run", lastRunText(base, w, onBoard)],
    ["Queue", `${queueBits.join(" · ")}${q.paused ? ` · <span class="warnv">paused</span>` : ""}`],
    ["Fork token", w.token.known ? tick(w.token.ok, "ok", "missing") : `<span class="muted">unknown</span>`],
    ["Hermes timeout", esc(minutes(w.hermesTimeoutSec))],
    ["systemd", systemdText(w, full)],
  ];
  if (full) {
    facts.splice(1, 0, [
      "Heartbeat",
      w.heartbeatAt
        ? `<span data-hb-age>${esc(durationLabel(w.heartbeatAgeSec))}</span> ago <span class="muted small">(every ${esc(durationLabel(w.heartbeatSec))} while running, stale after ${esc(minutes(w.staleAfterSec))})</span>`
        : `<span class="muted">never</span>`,
    ]);
    facts.push(["Limits", `lab ${esc(minutes(w.labTimeoutSec))} · ${esc(w.maxAttempts || "?")} fix attempts · kinds ${esc(w.kinds.join(", ") || "none")}`]);
  }
  const hbAt = w.heartbeatAt || "";
  return `<section class="wpanel ${full ? "wp-full" : "wp-board"} st-${esc(state)}" id="worker-panel" data-worker-panel data-state="${esc(w.state)}" data-display="${esc(state)}" data-hb="${hbAt}" data-stale-after="${w.staleAfterSec}" data-job-incident="${w.job?.incidentId || ""}" data-job-kind="${esc(w.job?.kind || "")}" data-job-stage="${esc(w.job ? w.job.stageText : "")}" data-job-started="${w.job?.startedAt || ""}" aria-label="Autofix worker">
    <div class="wp-head">
      <span class="wp-pill" data-state-pill title="${esc(stateTitle(w))}"><i class="dot" aria-hidden="true"></i><span data-state-text>${esc(STATE_TEXT[state] || state)}</span></span>
      ${jobLine(base, w, onBoard)}
      <span class="wp-actions">${cancelRunning}${pauseButton(base, w, q, returnTo, ro)}${full ? "" : `<a class="kbtn" href="${esc(`${base}/queue`)}">Queue &amp; worker ›</a>`}</span>
    </div>
    <dl class="wp-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>
    ${issueList(base, w, onBoard, full ? 10 : 1)}
  </section>`;
}

const PRIO_LABEL = { high: "High", normal: "Normal", low: "Low" };

function prioritySelect(base, j, ro) {
  if (ro) return `<span class="chip prio p-${esc(j.priority)}">${esc(PRIO_LABEL[j.priority])}</span>`;
  const opts = Object.entries(PRIO_LABEL)
    .map(([v, l]) => `<option value="${v}"${v === j.priority ? " selected" : ""}>${l}</option>`)
    .join("");
  return `<form class="qform prio-form" method="post" action="${esc(`${base}/queue/priority`)}" data-qaction="priority">${hiddenFields({ kind: j.kind, job: j.name, return_to: "queue" })}<label class="sr-only" for="prio-${esc(j.kind)}-${esc(j.name)}">Priority</label><select class="prio p-${esc(j.priority)}" id="prio-${esc(j.kind)}-${esc(j.name)}" name="priority" data-autosubmit>${opts}</select><button class="kbtn nojs-only" type="submit">Set</button></form>`;
}

function section(title, count, body, { id, note = "" } = {}) {
  return `<section class="qsec" id="${esc(id)}" aria-labelledby="${esc(id)}-h"><header><h2 id="${esc(id)}-h">${esc(title)} <span class="count">${count}</span></h2>${note ? `<p class="muted small">${note}</p>` : ""}</header>${body}</section>`;
}

function table(headers, rows, empty) {
  if (!rows.length) return `<p class="qempty muted">${esc(empty)}</p>`;
  return `<div class="qtable-wrap"><table class="qtable"><thead><tr>${headers.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

const kindChip = (k) => `<span class="chip kind k-${esc(k)}">${esc(k)}</span>`;

const REASON_CHIP = {
  crashed_worker: ["crashed worker", /^crashed worker\s*/i],
  cancelled: ["cancelled", /^cancelled\s*/i],
  malformed_job: ["malformed job", /^malformed job( JSON)?\s*/i],
  results_unwritable: ["result not writable", /^results? not writable\s*/i],
  disk_full: ["disk full", /^worker error:\s*/i],
  worker_error: ["worker error", /^worker error:\s*/i],
};

/** Reason chip + the remaining detail (no "crashed worker · crashed worker (…)"). */
function reasonCell(f) {
  const def = f.code ? REASON_CHIP[f.code] : null;
  let detail = f.reason || f.summary || (f.status ? f.status.replace(/_/g, " ") : "failed");
  if (def) detail = detail.replace(def[1], "").replace(/^\((.*)\)$/, "$1").trim();
  const chip = f.code ? `<span class="chip rc rc-${esc(f.code)}">${esc(def ? def[0] : f.code.replace(/_/g, " "))}</span>` : "";
  return `${chip}${detail ? ` <span class="rc-detail">${esc(detail)}</span>` : ""}`;
}
const when = (label, sec) => `<span class="nowrap">${esc(label)}</span> <span class="muted small nowrap">${esc(agoLabel(sec))} ago</span>`;

/** Queue view body (live-refreshable section: data-queue-view). */
export function renderQueueSections(w, q, { base, caps }) {
  const ro = Boolean(caps.readOnly);
  const pendingRows = q.pending.map((j, i) => {
    const last = i === q.pending.length - 1;
    const moves = ro
      ? ""
      : `<span class="qmoves">${actionButton(base, "move", "", { kind: j.kind, job: j.name, direction: "top", return_to: "queue" }, { icon: I.top, title: "Move to top (claimed next)" })}${actionButton(base, "move", "", { kind: j.kind, job: j.name, direction: "up", return_to: "queue" }, { icon: I.up, title: "Move up" })}${actionButton(base, "move", "", { kind: j.kind, job: j.name, direction: "down", return_to: "queue" }, { icon: I.down, title: "Move down" })}</span>`;
    return `<tr data-job="${esc(j.key)}"${i === 0 && !q.paused ? ` class="next"` : ""}>
      <td class="mono">${j.position}${i === 0 ? `<span class="sr-only"> (next)</span>` : ""}</td>
      <td>${kindChip(j.kind)}${j.kindEnabled ? "" : ` <span class="warnv small" title="This job kind is disabled on the host">kind off</span>`}</td>
      <td>${incLink(base, j.incidentId, false)}</td>
      <td title="${esc(j.name)}">${when(j.enqueuedLabel, j.ageSec)}</td>
      <td>${prioritySelect(base, j, ro)}${j.explicit ? "" : ` <span class="muted small" title="Default priority">default</span>`}</td>
      <td class="qact">${moves}${actionButton(base, "cancel", "Cancel", { kind: j.kind, job: j.name, return_to: "queue" }, { icon: I.x, ro, title: "Cancel this pending job", confirm: `Cancel the pending ${j.kind} job for #${j.incidentId}?` })}${last ? "" : ""}</td>
    </tr>`;
  });
  const procRows = q.processing.map(
    (p) => `<tr>
      <td>${kindChip(p.kind)}</td>
      <td>${incLink(base, p.incidentId, false)}</td>
      <td><b>${esc(p.stageText)}</b></td>
      <td class="mono" data-elapsed-from="${p.claimedAt || ""}">${esc(durationLabel(p.elapsedSec))}</td>
      <td>${p.claims > 1 ? `<span class="warnv">claim ${p.claims}/2</span>` : "1"}</td>
      <td class="qact">${p.cancelRequested ? `<span class="warnv">cancel requested</span>` : actionButton(base, "cancel-running", "Cancel running", { job: p.name, return_to: "queue" }, { cls: "danger", icon: I.x, ro, confirm: `Cancel the running ${p.kind} job for #${p.incidentId}? The worker stops it at the next checkpoint (Hermes' process group gets SIGTERM).` })}</td>
    </tr>`,
  );
  const failedRows = q.failed.map(
    (f) => `<tr>
      <td>${kindChip(f.kind)}</td>
      <td>${incLink(base, f.incidentId, false)}</td>
      <td>${when(f.finishedLabel, f.ageSec)}</td>
      <td class="qreason">${reasonCell(f)}</td>
      <td class="qact">${f.retriedAt ? `<span class="muted small">retried ${esc(f.retriedLabel)}</span>` : f.canRetry ? actionButton(base, "retry", "Retry", { job: f.name, return_to: "queue" }, { icon: I.retry, ro, title: "Re-enqueue a fresh job for this incident" }) : ""}</td>
    </tr>`,
  );
  const doneRows = q.done.map(
    (d) => `<tr>
      <td>${kindChip(d.kind)}</td>
      <td>${incLink(base, d.incidentId, false)}</td>
      <td>${when(d.finishedLabel, d.ageSec)}</td>
      <td>${d.status ? `<span class="chip st ${/failed|blocked|denied|needs_human/.test(d.status) ? "bad" : "ok"}">${esc(d.status.replace(/_/g, " "))}</span>` : `<span class="muted">result not ingested</span>`}</td>
      <td class="qreason">${esc(d.summary)}</td>
    </tr>`,
  );
  const orderNote = `Claim order: priority, then manual order, then kind (push › triage › fix), then age. ${q.paused ? "<b>Queue paused</b> — nothing is claimed until resumed." : ""}`;
  return `<div class="qgrid" data-queue-view>
    <div class="qcol">
    ${section("Pending", q.pending.length, table(["#", "Kind", "Incident", "Enqueued", "Priority", ro ? "" : "Actions"], pendingRows, "No pending jobs."), { id: "q-pending", note: orderNote })}
    ${section("Recent done", q.done.length, table(["Kind", "Incident", "Finished", "Result", "Summary"], doneRows, "No finished jobs yet."), { id: "q-done" })}
    </div>
    <div class="qcol">
    ${section("Processing", q.processing.length, table(["Kind", "Incident", "Stage", "Elapsed", "Claims", ""], procRows, "Nothing is running."), { id: "q-processing" })}
    ${section("Recent failed", q.failed.length, table(["Kind", "Incident", "Finished", "Reason", ""], failedRows, "No failed jobs."), { id: "q-failed" })}
    </div>
  </div>`;
}

export function renderQueuePage(w, q, { base, caps, flash = "", rev = "" }) {
  const cfg = { base, readOnly: Boolean(caps.readOnly), rev, page: "queue", now: Date.now() };
  return `<div class="board-wrap queue-page${caps.readOnly ? " is-ro" : ""}">
    <div class="board-head">
      <h1>Queue &amp; worker</h1>
      <p class="board-status muted"><a href="${esc(`${base}/`)}">← Board</a>${caps.readOnly ? ` · <strong class="ro">read-only</strong>` : ""}</p>
      ${liveIndicator()}
    </div>
    ${flash}
    <div data-worker-slot>${renderWorkerPanel(w, q, { base, caps, variant: "full" })}</div>
    <div data-queue-slot>${renderQueueSections(w, q, { base, caps })}</div>
    <div class="toasts" aria-live="polite" aria-atomic="false" data-toasts></div>
    <script type="application/json" id="live-config">${JSON.stringify(cfg).replace(/</g, "\\u003c")}</script>
    <script src="/js/live.js" defer></script>
    <script src="/js/queue.js" defer></script>
  </div>`;
}

/** Small "running" strip on the card of the incident the worker is on. */
export function renderRunLine(job) {
  if (!job) return "";
  return `<div class="kc-run" data-run>${`<i class="dot" aria-hidden="true"></i>`}<span>${esc(job.kind)} · ${esc(job.stageText)}</span><span class="mono" data-elapsed-from="${job.startedAt || ""}">${esc(durationLabel(job.elapsedSec))}</span></div>`;
}
