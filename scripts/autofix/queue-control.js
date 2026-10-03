/**
 * Autofix queue control: priority ordering, pause flag, cancel flags.
 *
 * Shared by the ops app (container, writes control files) and the host worker
 * (reads them before every claim). Byte-identical copies live in app/lib and
 * scripts/autofix (a test enforces it); only node builtins may be imported.
 *
 * Layout under <queue root> (= $OPS_DATA_DIR/queue):
 *   <kind>/<incident>-<ts>.json        pending job (kind = triage | fix | push | lab | pr)
 *   processing/<kind>-<name>           claimed job
 *   done/ failed/                      finished jobs (+ optional <base>.reason.json)
 *   control/paused.json                pause flag: worker claims nothing new
 *   control/priority.json              {version, jobs: {"<kind>/<name>": {priority, rank}}}
 *   control/cancel-<processing name>   cancel request for the running job
 * Control files are written atomically (tmp + rename) and never rewrite job files,
 * so a claim (rename) can never race with a priority change.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const KINDS = ["triage", "fix", "push", "lab", "pr"];
export const PRIORITIES = ["high", "normal", "low"];
export const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
/**
 * Default across kinds: pushing a finished fix is cheap; a lab test finishes a
 * fix that is already pushed (and holds the host's activation lock briefly);
 * triage is quick; fix is long.
 */
export const KIND_RANK = { push: 0, pr: 0, lab: 1, triage: 2, fix: 3 };
export const JOB_NAME_RE = /^(\d+)-[A-Za-z0-9-]+\.json$/;
export const STALE_HEARTBEAT_SEC_DEFAULT = 300;

export function controlDir(queueRoot) {
  return path.join(queueRoot, "control");
}

export function jobKey(kind, name) {
  return `${kind}/${name}`;
}

export function isValidJobName(name) {
  return typeof name === "string" && JOB_NAME_RE.test(name) && !name.includes("..");
}

/** Enqueue time from "<id>-2026-09-30T10-15-00-000Z.json", else NaN. */
export function enqueuedAtFromName(name) {
  const m = /-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/.exec(String(name || ""));
  if (!m) return NaN;
  return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
}

/**
 * tmp + rename. The tmp file is created with O_EXCL under a random name: the
 * exchange dirs are writable by the container, so a planted symlink must never
 * be followed (the kick watchdog writes here as root).
 */
export function atomicWriteJson(file, obj, mode = 0o660) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readPriorityFile(queueRoot) {
  const raw = readJson(path.join(controlDir(queueRoot), "priority.json"));
  const jobs = {};
  if (raw && raw.jobs && typeof raw.jobs === "object") {
    for (const [k, v] of Object.entries(raw.jobs)) {
      if (!v || typeof v !== "object") continue;
      const entry = {};
      if (PRIORITIES.includes(v.priority)) entry.priority = v.priority;
      if (Number.isFinite(v.rank)) entry.rank = v.rank;
      jobs[k] = entry;
    }
  }
  return { version: 1, jobs, updated_at: raw?.updated_at || null };
}

export function writePriorityFile(queueRoot, data) {
  fs.mkdirSync(controlDir(queueRoot), { recursive: true });
  atomicWriteJson(path.join(controlDir(queueRoot), "priority.json"), {
    version: 1,
    jobs: data.jobs || {},
    updated_at: new Date().toISOString(),
  });
}

/**
 * List pending jobs of the given kinds (default all), each with its effective
 * priority, in the order the worker will claim them.
 * @returns {{kind, name, file, key, priority, explicit, rank, enqueuedAt}[]}
 */
export function listPending(queueRoot, kinds = KINDS, prio = null) {
  const p = prio || readPriorityFile(queueRoot);
  const out = [];
  for (const kind of kinds) {
    const dir = path.join(queueRoot, kind);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.includes(".tmp-")) continue;
      const file = path.join(dir, name);
      let at = enqueuedAtFromName(name);
      if (!Number.isFinite(at)) {
        try {
          at = fs.statSync(file).mtimeMs;
        } catch {
          continue; // claimed meanwhile
        }
      }
      const key = jobKey(kind, name);
      const entry = p.jobs[key] || {};
      out.push({
        kind,
        name,
        file,
        key,
        priority: entry.priority || "normal",
        explicit: Boolean(entry.priority),
        rank: Number.isFinite(entry.rank) ? entry.rank : null,
        enqueuedAt: at,
      });
    }
  }
  return sortPending(out);
}

/** Priority, then manual rank (drag order), then kind default, then enqueue time. */
export function comparePending(a, b) {
  const pa = PRIORITY_RANK[a.priority] ?? 1;
  const pb = PRIORITY_RANK[b.priority] ?? 1;
  if (pa !== pb) return pa - pb;
  const ra = a.rank ?? Infinity;
  const rb = b.rank ?? Infinity;
  if (ra !== rb) return ra < rb ? -1 : 1;
  const ka = KIND_RANK[a.kind] ?? 9;
  const kb = KIND_RANK[b.kind] ?? 9;
  if (ka !== kb) return ka - kb;
  if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function sortPending(list) {
  return [...list].sort(comparePending);
}

/**
 * Pure: new priority map after moving `key` up/down/top/bottom within the
 * pending list. The moved job adopts the priority of the job it jumped over
 * (so the move is visible in the claim order), and ranks are rewritten
 * for every pending job so the manual order is total.
 */
export function applyMove(pending, prioJobs, key, direction) {
  const list = sortPending(pending);
  const idx = list.findIndex((j) => j.key === key);
  if (idx < 0) return null;
  const item = list.splice(idx, 1)[0];
  let to = idx;
  if (direction === "up") to = Math.max(0, idx - 1);
  else if (direction === "down") to = Math.min(list.length, idx + 1);
  else if (direction === "top") to = 0;
  else if (direction === "bottom") to = list.length;
  else return null;
  list.splice(to, 0, item);
  const jobs = {};
  const live = new Set(list.map((j) => j.key));
  for (const [k, v] of Object.entries(prioJobs || {})) if (live.has(k)) jobs[k] = { ...v };
  // The job it jumped over decides the priority group it lands in.
  const neighbour = direction === "up" || direction === "top" ? list[to + 1] : list[to - 1];
  if (neighbour && neighbour.priority !== item.priority) {
    item.priority = neighbour.priority;
    jobs[key] = { ...(jobs[key] || {}), priority: neighbour.priority };
  }
  list.forEach((j, i) => {
    jobs[j.key] = { ...(jobs[j.key] || {}), rank: i };
  });
  return jobs;
}

/** Pure: drop entries for jobs that are no longer pending. */
export function prunePriorityJobs(prioJobs, pending) {
  const live = new Set(pending.map((j) => j.key));
  const jobs = {};
  for (const [k, v] of Object.entries(prioJobs || {})) if (live.has(k)) jobs[k] = v;
  return jobs;
}

export function pauseFile(queueRoot) {
  return path.join(controlDir(queueRoot), "paused.json");
}

/** @returns {null | {paused_at: string|null}} */
export function readPause(queueRoot) {
  const f = pauseFile(queueRoot);
  if (!fs.existsSync(f)) return null;
  const raw = readJson(f);
  return { paused_at: raw?.paused_at || null };
}

export function setPaused(queueRoot, paused) {
  const f = pauseFile(queueRoot);
  if (paused) {
    fs.mkdirSync(controlDir(queueRoot), { recursive: true });
    atomicWriteJson(f, { paused_at: new Date().toISOString() });
  } else {
    fs.rmSync(f, { force: true });
    kickPathUnit(queueRoot);
  }
}

/**
 * The systemd path unit watches only the kind dirs (PathChanged). After a
 * resume, create + remove a dot file in each kind dir that has pending jobs so
 * the worker starts now instead of at the next kick-timer run. Best effort.
 */
export function kickPathUnit(queueRoot) {
  const kinds = new Set(listPending(queueRoot).map((j) => j.kind));
  for (const kind of kinds) {
    const f = path.join(queueRoot, kind, `.kick-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    try {
      fs.writeFileSync(f, "", { flag: "wx", mode: 0o660 });
      fs.rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
}

export function cancelFile(queueRoot, processingName) {
  return path.join(controlDir(queueRoot), `cancel-${processingName}`);
}

export function cancelRequested(queueRoot, processingName) {
  return fs.existsSync(cancelFile(queueRoot, processingName));
}

/** Reason sidecar next to a failed/done entry: <base>.reason.json */
export function reasonFile(bucketDir, entryName) {
  return path.join(bucketDir, entryName.replace(/\.json$/, "") + ".reason.json");
}
