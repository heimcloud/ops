/**
 * Ingest worker results from OPS_DATA_DIR/results/*.json into incident_events.
 */
import fs from "node:fs";
import path from "node:path";
import {
  getIncident,
  updateIncident,
  addIncidentEvent,
  addFixAttempt,
  nextFixAttemptNumber,
} from "./db.js";
import { resultsDir } from "./queue.js";

let lastDirWarning = "";

function warnOnce(msg) {
  if (msg === lastDirWarning) return;
  lastDirWarning = msg;
  console.warn(`[results] ${msg}`);
}

/**
 * Never throws for a missing/unreadable results dir (it is polled on every
 * admin page load and ingest); logs once per distinct problem instead.
 * @returns {{ ingested: number, errors: string[], skipped?: string }}
 */
export function ingestResultsDir() {
  const dir = resultsDir();
  const errors = [];
  let ingested = 0;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === "ENOENT") return { ingested, errors, skipped: "no_results_dir" };
    const msg = `results dir ${dir} unreadable (${err.code || err.message}); host must create it owned by the Neo core user, mode 2770`;
    warnOnce(msg);
    return { ingested, errors: [msg], skipped: "unreadable" };
  }
  lastDirWarning = "";
  const files = names
    .filter(
      (f) =>
        f.endsWith(".json") &&
        !f.endsWith(".ingested.json") &&
        !f.endsWith(".rejected.json"),
    )
    .sort();

  for (const file of files) {
    const full = path.join(dir, file);
    const claimed = full.replace(/\.json$/, ".ingested.json");
    // Claim first (atomic rename), then apply: a result is applied at most once
    // even if the page-load path and the background loop overlap, and a failed
    // rename can never lead to a second apply on the next tick.
    try {
      fs.renameSync(full, claimed);
    } catch (err) {
      if (err.code !== "ENOENT") {
        const msg = `cannot claim ${file} (${err.code || err.message}); results dir must be writable by the container`;
        warnOnce(msg);
        errors.push(msg);
      }
      continue;
    }
    try {
      const result = JSON.parse(fs.readFileSync(claimed, "utf8"));
      applyResult(result);
      ingested += 1;
    } catch (err) {
      errors.push(`${file}: ${err.message || err}`);
      // Park bad results so they are not retried forever.
      try {
        fs.renameSync(claimed, full.replace(/\.json$/, ".rejected.json"));
      } catch {
        /* ignore */
      }
      console.error(`[results] ${file}: ${err.message || err}`);
    }
  }
  return { ingested, errors };
}

/**
 * Background ingest: poll every intervalMs (authoritative) plus a best-effort
 * fs.watch on the results dir (inotify works on a bind mount; it is re-armed
 * by the poll if it dies or the dir appears later). Never throws; errors are
 * warned once per distinct message.
 * @returns {{ stop: () => void, tick: () => void }}
 */
export function startResultsIngestLoop({ intervalMs = 15_000, watch = true } = {}) {
  let watcher = null;
  let debounce = null;
  let lastLoopError = "";

  const tick = () => {
    try {
      const r = ingestResultsDir();
      if (r.ingested) console.log(`[results] background ingest: ${r.ingested} result(s)`);
      lastLoopError = "";
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (msg !== lastLoopError) {
        lastLoopError = msg;
        console.warn(`[results] background ingest failed: ${msg}`);
      }
    }
    if (watch && !watcher) arm();
  };

  const arm = () => {
    try {
      watcher = fs.watch(resultsDir(), { persistent: false }, (_ev, name) => {
        if (name && !String(name).endsWith(".json")) return;
        if (String(name || "").endsWith(".ingested.json") || String(name || "").endsWith(".rejected.json")) return;
        clearTimeout(debounce);
        debounce = setTimeout(tick, 500);
        debounce.unref?.();
      });
      watcher.on("error", () => {
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
        watcher = null; // re-armed on the next poll
      });
    } catch {
      watcher = null; // dir missing / unwatchable: polling still covers it
    }
  };

  tick();
  const timer = intervalMs > 0 ? setInterval(tick, intervalMs) : null;
  timer?.unref?.();
  return {
    tick,
    stop() {
      if (timer) clearInterval(timer);
      clearTimeout(debounce);
      if (watcher) watcher.close();
      watcher = null;
    },
  };
}

export function applyResult(result) {
  const id = Number(result.incident_id);
  if (!id) throw new Error("incident_id_required");
  const incident = getIncident(id);
  if (!incident) throw new Error(`incident_not_found:${id}`);

  const kind = result.kind || "unknown";
  if (kind === "triage" || result.type === "triage") {
    const klass = result.class || incident.class;
    // Only promote open → triaged; never pull a fixing/testing incident back.
    const status =
      result.status !== "triage_failed" && incident.status === "open"
        ? "triaged"
        : incident.status;
    updateIncident(id, {
      class: ["software", "human_config", "unknown"].includes(klass)
        ? klass
        : incident.class,
      status,
      target_repo: result.target_repo || incident.target_repo,
    });
    addIncidentEvent(id, "triage_result", result.summary || "Triage result", result);
    return;
  }

  // fix result
  const attempt = nextFixAttemptNumber(id);
  addFixAttempt(id, {
    attempt,
    branch: result.branch,
    result: result.status || "unknown",
    evidence_path: result.evidence_path,
    compare_url: result.compare_url,
    meta: result,
  });

  const patch = {};
  if (result.branch) patch.draft_branch = result.branch;
  if (result.compare_url) patch.compare_url = result.compare_url;
  if (result.pr_title) patch.prepared_pr_title = result.pr_title;
  if (result.pr_body) patch.prepared_pr_body = result.pr_body;
  if (result.pr_url) patch.draft_pr_url = result.pr_url;
  if (result.pr_number) patch.draft_pr_number = result.pr_number;

  patch.status = fixStatusToIncidentStatus(result.status);
  if (Object.keys(patch).length) updateIncident(id, patch);
  addIncidentEvent(id, "fix_result", result.summary || result.status || "Fix result", result);
}

/**
 * Worker fix-result status → incident status. Unknown / failure statuses land in
 * needs_human so an incident never sits in "fixing" forever.
 */
export function fixStatusToIncidentStatus(st) {
  switch (st) {
    case "fixing":
      return "fixing";
    case "awaiting_lab_test":
    case "testing":
      return "testing";
    case "pr_opened":
    case "compare_ready":
      return "pr_opened";
    case "no_token":
    case "ready_no_token":
    case "disabled":
      // Nothing was pushed: back to triaged (fix is committed locally in the
      // job scratch dir and waits for the fork-push token).
      return "triaged";
    default:
      // needs_human, redaction_blocked, denied, lab_failed, failed, error, …
      return "needs_human";
  }
}
