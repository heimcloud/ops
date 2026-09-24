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

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

/**
 * @returns {{ ingested: number, errors: string[] }}
 */
export function ingestResultsDir() {
  const dir = resultsDir();
  ensureDir(dir);
  const errors = [];
  let ingested = 0;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".ingested.json"))
    .sort();

  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const raw = fs.readFileSync(full, "utf8");
      const result = JSON.parse(raw);
      applyResult(result);
      const done = full.replace(/\.json$/, ".ingested.json");
      fs.renameSync(full, done);
      ingested += 1;
    } catch (err) {
      errors.push(`${file}: ${err.message || err}`);
    }
  }
  return { ingested, errors };
}

export function applyResult(result) {
  const id = Number(result.incident_id);
  if (!id) throw new Error("incident_id_required");
  const incident = getIncident(id);
  if (!incident) throw new Error(`incident_not_found:${id}`);

  const kind = result.kind || "unknown";
  if (kind === "triage" || result.type === "triage") {
    const klass = result.class || incident.class;
    const status =
      result.status === "triage_failed"
        ? incident.status
        : result.status || "triaged";
    updateIncident(id, {
      class: ["software", "human_config", "unknown"].includes(klass)
        ? klass
        : incident.class,
      status: status === "triage_failed" ? incident.status : status,
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

  const st = result.status;
  if (st === "awaiting_lab_test" || st === "testing") patch.status = "testing";
  else if (st === "needs_human" || st === "redaction_blocked" || st === "denied") {
    patch.status = "needs_human";
  } else if (st === "pr_opened" || st === "compare_ready") patch.status = "pr_opened";
  else if (st === "no_token") patch.status = "triaged";
  else if (st === "fixing") patch.status = "fixing";

  if (Object.keys(patch).length) updateIncident(id, patch);
  addIncidentEvent(id, "fix_result", result.summary || st || "Fix result", result);
}
