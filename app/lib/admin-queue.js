/**
 * Admin routes for live updates and the autofix queue / worker panel.
 * Mounted by createAdminRouter (same-origin guard + ADMIN_READ_ONLY apply).
 * Queue actions write control files atomically (queue-control.js) and an
 * incident_events row whenever the job belongs to an incident.
 */
import { adminLayout, escapeHtml } from "./layout.js";
import { getIncident, updateIncident, addIncidentEvent, countByStatus } from "./db.js";
import { enqueueJob, enqueuePushJob, enqueueLabRetry } from "./queue.js";
import {
  workerModel,
  queueModel,
  pauseQueue,
  setJobPriority,
  moveJob,
  cancelPendingJob,
  requestCancelRunning,
  failedJobInfo,
  markRetried,
  QueueActionError,
} from "./worker-state.js";
import { renderWorkerPanel, renderQueueSections, renderQueuePage } from "./worker-view.js";
import { sseHandler, pollHandler, currentRevision, encodeRev } from "./live.js";

/**
 * @param {import("express").Router} router
 * @param {{ readOnly: boolean, capabilities: () => object, displayRedactor: () => Function,
 *           cardsFor: (ids: number[]|"all", base: string, caps: object) => object,
 *           wantsJson: Function, flash: Function, readOnlyBanner: Function }} ctx
 */
export function registerQueueRoutes(router, ctx) {
  const models = () => {
    const caps = ctx.capabilities();
    const redact = ctx.displayRedactor();
    const w = workerModel({ redact, caps });
    const q = queueModel({ redact, caps, worker: w });
    return { caps, w, q };
  };

  // ---- live transport
  router.get("/events", sseHandler);
  router.get("/live.json", pollHandler);

  // Cards to patch after a change event (?ids=1,2,3 or ?ids=all).
  router.get("/cards", (req, res) => {
    const raw = String(req.query.ids || "");
    const ids = raw === "all" ? "all" : raw.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
    const { caps, w } = models();
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, ...ctx.cardsFor(ids, req.adminBase, { ...caps, runningJob: w.job }), counts: countByStatus() });
  });

  // Worker panel (+ queue sections for the queue page).
  router.get("/worker.json", (req, res) => {
    const { caps, w, q } = models();
    const full = req.query.variant === "full";
    const base = req.adminBase;
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      display: w.display,
      job: w.job ? { kind: w.job.kind, incidentId: w.job.incidentId, stageText: w.job.stageText, startedAt: w.job.startedAt, labPhase: w.job.labPhase ?? null } : null,
      counts: q.counts,
      paused: Boolean(q.paused),
      worker_html: renderWorkerPanel(w, q, { base, caps, variant: full ? "full" : "board" }),
      ...(full ? { queue_html: renderQueueSections(w, q, { base, caps }) } : {}),
    });
  });

  // Redacted models (tools/tests). Never raw file content.
  router.get("/queue.json", (req, res) => {
    const { w, q } = models();
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, worker: w, queue: q });
  });

  router.get("/queue", (req, res) => {
    const { caps, w, q } = models();
    const base = req.adminBase;
    res.type("html").send(
      adminLayout({
        title: "Queue & worker",
        basePath: base,
        readOnly: caps.readOnly,
        wide: true,
        head: `<link rel="stylesheet" href="/css/board.css" />`,
        body: renderQueuePage(w, q, { base, caps, flash: `${ctx.readOnlyBanner()}${ctx.flash(req.query)}`, rev: encodeRev(currentRevision()) }),
      }),
    );
  });

  // ---- actions
  function action(name, fn) {
    router.post(`/queue/${name}`, (req, res) => {
      const base = req.adminBase;
      const json = ctx.wantsJson(req);
      const back = (key, text) =>
        `${String(req.body?.return_to || "") === "board" ? `${base}/` : `${base}/queue`}?${key}=${encodeURIComponent(text)}`;
      if (ctx.readOnly) {
        const message = "Admin is read-only (ADMIN_READ_ONLY).";
        if (json) return res.status(403).json({ ok: false, error: "read_only", message });
        return res.status(403).type("html").send(
          adminLayout({ title: "Read-only", basePath: base, readOnly: true, body: `${ctx.readOnlyBanner()}<p><a href="${escapeHtml(`${base}/queue`)}">Back</a></p>` }),
        );
      }
      try {
        const message = fn(req.body || {});
        if (json) return res.json({ ok: true, message });
        return res.redirect(303, back("msg", message));
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error(`[admin] queue/${name}`, err.code || "", err.message);
        const message = err instanceof QueueActionError || err.status ? err.message : "Queue action failed.";
        if (json) return res.status(status).json({ ok: false, error: err.code || "queue_action_failed", message });
        return res.redirect(303, back("err", message));
      }
    });
  }

  const str = (v) => String(v ?? "").trim();

  action("pause", () => {
    pauseQueue(true);
    return "Queue paused: the running job finishes, nothing new is claimed.";
  });
  action("resume", () => {
    pauseQueue(false);
    return "Queue resumed.";
  });

  action("priority", (b) => {
    const kind = str(b.kind);
    const job = str(b.job);
    const out = setJobPriority(kind, job, str(b.priority));
    if (getIncident(out.incidentId) && out.from !== out.to) {
      addIncidentEvent(out.incidentId, "job_priority", `${kind} job priority ${out.from} -> ${out.to}`, { job_kind: kind, job_file: job, from: out.from, to: out.to });
    }
    return out.from === out.to ? `Priority unchanged (${out.to}).` : `#${out.incidentId} ${kind}: priority ${out.from} → ${out.to}.`;
  });

  action("move", (b) => {
    const kind = str(b.kind);
    const job = str(b.job);
    const dir = str(b.direction);
    const out = moveJob(kind, job, dir);
    const prio = out.priority !== out.priorityFrom ? `; priority ${out.priorityFrom} -> ${out.priority}` : "";
    if (getIncident(out.incidentId) && out.from !== out.to) {
      addIncidentEvent(out.incidentId, "job_reordered", `${kind} job moved ${dir} (position ${out.from} -> ${out.to})${prio}`, {
        job_kind: kind,
        job_file: job,
        from: out.from,
        to: out.to,
        priority: out.priority,
      });
    }
    return out.from === out.to ? "Already there." : `#${out.incidentId} ${kind}: position ${out.from} → ${out.to}${prio.replace("->", "→")}.`;
  });

  action("cancel", (b) => {
    const kind = str(b.kind);
    const job = str(b.job);
    const out = cancelPendingJob(kind, job);
    const inc = getIncident(out.incidentId);
    let msg = `Pending ${kind} job cancelled by admin`;
    if (inc) {
      const meta = { job_kind: kind, job_file: job, stage: "pending" };
      // Start fix put the incident into "fixing"; without the job it goes back.
      if (kind === "fix" && inc.status === "fixing") {
        updateIncident(inc.id, { status: "triaged" });
        msg += "; status fixing -> triaged";
        Object.assign(meta, { from: "fixing", to: "triaged" });
      }
      addIncidentEvent(inc.id, "job_cancelled", msg, meta);
    }
    return `#${out.incidentId}: ${msg.replace("->", "→")}.`;
  });

  action("cancel-running", (b) => {
    const job = str(b.job);
    const { w } = models();
    const out = requestCancelRunning(job);
    const stage = w.job && w.job.processing === job ? w.job.stageText : "unknown stage";
    if (getIncident(out.incidentId)) {
      addIncidentEvent(out.incidentId, "job_cancel_requested", `Cancel requested for the running ${out.kind} job (${stage})`, {
        job_kind: out.kind,
        job_file: job,
        stage,
      });
    }
    if (out.kind === "lab") {
      return `Cancel requested for #${out.incidentId} (lab): honoured only before activation; once the host is activating, the test finishes and rolls back.`;
    }
    return `Cancel requested for #${out.incidentId} (${out.kind}); the worker stops at its next checkpoint.`;
  });

  action("retry", (b) => {
    const name = str(b.job);
    const info = failedJobInfo(name);
    const incident = getIncident(info.incidentId);
    if (!incident) throw new QueueActionError("not_found", `Incident #${info.incidentId} not found.`, 404);
    if (["resolved", "closed"].includes(incident.status)) {
      throw new QueueActionError("incident_done", `Incident #${incident.id} is ${incident.status}; reopen it before retrying.`);
    }
    let file;
    if (info.kind === "lab") {
      file = enqueueLabRetry(incident, info.job).path.split("/").pop();
      if (incident.status !== "testing") updateIncident(incident.id, { status: "testing" });
      addIncidentEvent(incident.id, "lab_enqueued", `Lab test re-enqueued (retry of failed job ${name})`, {
        job_file: file,
        job_kind: "lab",
        retry_of: name,
      });
    } else if (info.kind === "push") {
      if (!info.pushJob) throw new QueueActionError("invalid_push_job", "The failed push job has no saved fix name.");
      file = enqueuePushJob(incident, info.pushJob).path.split("/").pop();
      addIncidentEvent(incident.id, "push_enqueued", `Push retry enqueued for saved fix ${info.pushJob} (retry of failed job ${name})`, {
        job: info.pushJob,
        job_file: file,
        job_kind: "push",
        retry_of: name,
      });
    } else {
      file = enqueueJob(info.kind, incident).path.split("/").pop();
      if (info.kind === "fix") updateIncident(incident.id, { status: "fixing" });
      addIncidentEvent(incident.id, `${info.kind}_enqueued`, `${info.kind === "fix" ? "Fix" : "Triage"} job re-enqueued (retry of failed job ${name})`, {
        job_file: file,
        job_kind: info.kind,
        retry_of: name,
      });
    }
    markRetried(name, file);
    return `#${incident.id}: ${info.kind} job re-enqueued.`;
  });
}
