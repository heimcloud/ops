/**
 * PR-loop validation (no Fleet needed): a synthetic incident whose first fix
 * commit is written by the worker itself (no Hermes): one doc-only file
 * docs/ops-autofix-validation.md on branch ops/validation-pr-loop-<id> of the
 * neo fork. Then the normal loop runs: gates → guarded push → lab test → real
 * PR on madebydamo/neo titled "[validation] … DO NOT MERGE" → feedback
 * polling. A review comment from the configured reviewer drives one revise
 * round (Hermes edits the same doc file). Close the PR afterwards.
 *
 * Triggers: admin board "Run PR-loop validation" (POST /admin/validation/pr-loop)
 * or, on the host, `docker exec ops node /app/lib/validation.js`.
 */
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { upsertIncident, updateIncident, addIncidentEvent } from "./db.js";
import { enqueueJob, isAutofixKindEnabled, QueueError } from "./queue.js";
import { loadTargets } from "./targets.js";

export const VALIDATION_UNIT = "docker-ops.service";

export function startPrLoopValidation({ now = new Date() } = {}) {
  if (!isAutofixKindEnabled("fix")) throw new QueueError("autofix_disabled", "Autofix fix is not enabled on this host (autofix.fix.enable).");
  if (!isAutofixKindEnabled("pr")) throw new QueueError("autofix_disabled", "PR automation is not enabled on this host (autofix.pr.enable).");
  const target = loadTargets()[0];
  const { incident } = upsertIncident({
    report_hash: `validation-pr-loop-${now.getTime().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    unit: VALIDATION_UNIT,
    severity: "info",
    neo_version: "validation",
    target_hint: target.upstream,
    logs_excerpt:
      "Synthetic incident: autofix PR-loop validation. No real failure. The fix is a single doc-only file; the PR is labelled DO NOT MERGE.",
  });
  updateIncident(incident.id, { class: "software", status: "fixing", target_repo: target.upstream });
  const { path: jobPath, job } = enqueueJob("fix", { ...incident, class: "software", target_repo: target.upstream }, { validation: true });
  const job_file = jobPath.split("/").pop();
  addIncidentEvent(incident.id, "fix_enqueued", "PR-loop validation: fix job enqueued (doc-only branch, no Hermes for the first commit)", {
    target_repo: target.upstream,
    job_file,
    job_kind: job.kind,
    validation: true,
  });
  return { incident, job_file };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const r = startPrLoopValidation();
    console.log(`PR-loop validation started: incident #${r.incident.id}, fix job ${r.job_file}`);
  } catch (err) {
    console.error(`validation: ${err.message || err}`);
    process.exitCode = 1;
  }
}
