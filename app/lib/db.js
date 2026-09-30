/**
 * SQLite (better-sqlite3) with WAL + foreign keys.
 * Path: OPS_DB_PATH (default /data/ops.sqlite).
 * Schema version via PRAGMA user_version (v2 adds fixing/testing/needs_human + fix_attempts).
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.OPS_DB_PATH || "/data/ops.sqlite";

/** Schema user_version after autofix statuses + fix_attempts. */
export const SCHEMA_VERSION = 2;

const STATUSES = [
  "open",
  "triaged",
  "fixing",
  "testing",
  "needs_human",
  "pr_opened",
  "resolved",
  "closed",
];
const CLASSES = ["software", "human_config", "unknown"];

let db;

export function getDbPath() {
  return DB_PATH;
}

export function getStatuses() {
  return STATUSES;
}

export function getClasses() {
  return CLASSES;
}

/** Reset singleton (tests only). */
export function _resetDbForTests() {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  db = undefined;
}

export function getDb() {
  if (db) return db;

  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(database) {
  const version = Number(database.pragma("user_version", { simple: true }) || 0);
  if (version >= SCHEMA_VERSION) {
    ensureFixAttempts(database);
    return;
  }

  const tx = database.transaction(() => {
    const hasIncidents = database
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='incidents'`,
      )
      .get();

    if (!hasIncidents) {
      database.exec(createIncidentsSql());
      database.exec(createEventsSql());
      database.exec(createIndexesSql());
    } else {
      // Rebuild incidents to widen CHECK constraint (SQLite cannot ALTER CHECK).
      database.exec(`
        CREATE TABLE incidents_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          report_hash TEXT NOT NULL UNIQUE,
          neo_version TEXT,
          plugin_urls TEXT,
          unit TEXT,
          logs_excerpt TEXT,
          customer_repo_slug TEXT,
          severity TEXT,
          target_hint TEXT,
          target_repo TEXT,
          status TEXT NOT NULL DEFAULT 'open'
            CHECK (status IN (${STATUSES.map((s) => `'${s}'`).join(", ")})),
          class TEXT NOT NULL DEFAULT 'unknown'
            CHECK (class IN ('software', 'human_config', 'unknown')),
          draft_pr_url TEXT,
          draft_pr_number INTEGER,
          draft_branch TEXT,
          compare_url TEXT,
          prepared_pr_title TEXT,
          prepared_pr_body TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      const cols = database.prepare(`PRAGMA table_info(incidents)`).all();
      const names = new Set(cols.map((c) => c.name));
      const copy = [
        "id",
        "report_hash",
        "neo_version",
        "plugin_urls",
        "unit",
        "logs_excerpt",
        "customer_repo_slug",
        "severity",
        "target_hint",
        "target_repo",
        "status",
        "class",
        "draft_pr_url",
        "draft_pr_number",
        "draft_branch",
        "created_at",
        "updated_at",
      ].filter((c) => names.has(c));
      database.exec(
        `INSERT INTO incidents_new (${copy.join(", ")})
         SELECT ${copy.join(", ")} FROM incidents`,
      );
      database.exec(`DROP TABLE incidents`);
      database.exec(`ALTER TABLE incidents_new RENAME TO incidents`);
      database.exec(createEventsSql());
      database.exec(createIndexesSql());
    }

    ensureFixAttempts(database);
    database.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  tx();
}

function createIncidentsSql() {
  return `
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_hash TEXT NOT NULL UNIQUE,
      neo_version TEXT,
      plugin_urls TEXT,
      unit TEXT,
      logs_excerpt TEXT,
      customer_repo_slug TEXT,
      severity TEXT,
      target_hint TEXT,
      target_repo TEXT,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN (${STATUSES.map((s) => `'${s}'`).join(", ")})),
      class TEXT NOT NULL DEFAULT 'unknown'
        CHECK (class IN ('software', 'human_config', 'unknown')),
      draft_pr_url TEXT,
      draft_pr_number INTEGER,
      draft_branch TEXT,
      compare_url TEXT,
      prepared_pr_title TEXT,
      prepared_pr_body TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `;
}

function createEventsSql() {
  return `
    CREATE TABLE IF NOT EXISTS incident_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      message TEXT,
      meta_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `;
}

function createIndexesSql() {
  return `
    CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
    CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_incident_events_incident ON incident_events(incident_id);
  `;
}

function ensureFixAttempts(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS fix_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      branch TEXT,
      result TEXT,
      evidence_path TEXT,
      compare_url TEXT,
      meta_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (incident_id, attempt)
    );
    CREATE INDEX IF NOT EXISTS idx_fix_attempts_incident ON fix_attempts(incident_id);
  `);
}

export function addIncidentEvent(incidentId, kind, message, meta = null) {
  const database = getDb();
  const info = database
    .prepare(
      `INSERT INTO incident_events (incident_id, kind, message, meta_json)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      incidentId,
      kind,
      message || null,
      meta == null ? null : JSON.stringify(meta),
    );
  return database
    .prepare(`SELECT * FROM incident_events WHERE id = ?`)
    .get(info.lastInsertRowid);
}

/**
 * Idempotent ingest on report_hash.
 * @returns {{ incident: object, created: boolean }}
 */
export function upsertIncident(payload) {
  const database = getDb();
  const reportHash = String(payload.report_hash || "").trim();
  if (!reportHash) {
    throw Object.assign(new Error("report_hash_required"), { status: 400 });
  }

  const existing = database
    .prepare(`SELECT * FROM incidents WHERE report_hash = ?`)
    .get(reportHash);
  if (existing) {
    addIncidentEvent(existing.id, "ingest_duplicate", "Duplicate report_hash ignored", {
      report_hash: reportHash,
    });
    return { incident: existing, created: false };
  }

  const pluginUrls =
    payload.plugin_urls == null
      ? null
      : typeof payload.plugin_urls === "string"
        ? payload.plugin_urls
        : JSON.stringify(payload.plugin_urls);

  const severity = payload.severity != null ? String(payload.severity) : null;
  const targetHint = payload.target_hint != null ? String(payload.target_hint).trim() : null;
  const now = new Date().toISOString();

  const info = database
    .prepare(
      `INSERT INTO incidents (
        report_hash, neo_version, plugin_urls, unit, logs_excerpt,
        customer_repo_slug, severity, target_hint, target_repo,
        status, class, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'unknown', ?, ?)`,
    )
    .run(
      reportHash,
      payload.neo_version != null ? String(payload.neo_version) : null,
      pluginUrls,
      payload.unit != null ? String(payload.unit) : null,
      payload.logs_excerpt != null ? String(payload.logs_excerpt) : null,
      payload.customer_repo_slug != null ? String(payload.customer_repo_slug) : null,
      severity,
      targetHint,
      targetHint || null,
      now,
      now,
    );

  const incident = database
    .prepare(`SELECT * FROM incidents WHERE id = ?`)
    .get(info.lastInsertRowid);
  addIncidentEvent(incident.id, "ingest", "Incident ingested", {
    severity,
    target_hint: targetHint,
  });
  return { incident, created: true };
}

export function listIncidents({ status = null, limit = 100 } = {}) {
  const database = getDb();
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  if (status) {
    return database
      .prepare(
        `SELECT * FROM incidents WHERE status = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(status, lim);
  }
  return database
    .prepare(`SELECT * FROM incidents ORDER BY id DESC LIMIT ?`)
    .all(lim);
}

export function getIncident(id) {
  return getDb().prepare(`SELECT * FROM incidents WHERE id = ?`).get(id);
}

/** Most recent event of one kind (meta parsed), or null. */
export function getLatestIncidentEvent(incidentId, kind) {
  const row = getDb()
    .prepare(`SELECT * FROM incident_events WHERE incident_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`)
    .get(incidentId, kind);
  if (!row) return null;
  let meta = null;
  try {
    meta = row.meta_json ? JSON.parse(row.meta_json) : null;
  } catch {
    meta = null;
  }
  return { ...row, meta };
}

export function listIncidentEvents(incidentId, { limit = 100 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return getDb()
    .prepare(
      `SELECT * FROM incident_events WHERE incident_id = ? ORDER BY id ASC LIMIT ?`,
    )
    .all(incidentId, lim);
}

export function updateIncident(id, patch) {
  const database = getDb();
  const row = database.prepare(`SELECT * FROM incidents WHERE id = ?`).get(id);
  if (!row) return null;

  const next = { ...row };
  if (patch.status != null) {
    if (!STATUSES.includes(patch.status)) {
      throw Object.assign(new Error("invalid_status"), { status: 400 });
    }
    next.status = patch.status;
  }
  if (patch.class != null) {
    if (!CLASSES.includes(patch.class)) {
      throw Object.assign(new Error("invalid_class"), { status: 400 });
    }
    next.class = patch.class;
  }
  if (patch.target_repo !== undefined) {
    next.target_repo = patch.target_repo ? String(patch.target_repo).trim() : null;
  }
  if (patch.draft_pr_url !== undefined) next.draft_pr_url = patch.draft_pr_url;
  if (patch.draft_pr_number !== undefined) next.draft_pr_number = patch.draft_pr_number;
  if (patch.draft_branch !== undefined) next.draft_branch = patch.draft_branch;
  if (patch.compare_url !== undefined) next.compare_url = patch.compare_url;
  if (patch.prepared_pr_title !== undefined) {
    next.prepared_pr_title = patch.prepared_pr_title;
  }
  if (patch.prepared_pr_body !== undefined) {
    next.prepared_pr_body = patch.prepared_pr_body;
  }

  const now = new Date().toISOString();
  database
    .prepare(
      `UPDATE incidents SET
         status = ?, class = ?, target_repo = ?,
         draft_pr_url = ?, draft_pr_number = ?, draft_branch = ?,
         compare_url = ?, prepared_pr_title = ?, prepared_pr_body = ?,
         updated_at = ?
       WHERE id = ?`,
    )
    .run(
      next.status,
      next.class,
      next.target_repo,
      next.draft_pr_url,
      next.draft_pr_number,
      next.draft_branch,
      next.compare_url ?? null,
      next.prepared_pr_title ?? null,
      next.prepared_pr_body ?? null,
      now,
      id,
    );

  return database.prepare(`SELECT * FROM incidents WHERE id = ?`).get(id);
}

export function countByStatus() {
  const rows = getDb()
    .prepare(`SELECT status, COUNT(*) AS n FROM incidents GROUP BY status`)
    .all();
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export function listDistinctCustomerRepoSlugs() {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT customer_repo_slug AS slug FROM incidents
       WHERE customer_repo_slug IS NOT NULL AND trim(customer_repo_slug) != ''`,
    )
    .all();
  return rows.map((r) => String(r.slug));
}

export function addFixAttempt(incidentId, { attempt, branch, result, evidence_path, compare_url, meta } = {}) {
  const database = getDb();
  const info = database
    .prepare(
      `INSERT INTO fix_attempts (incident_id, attempt, branch, result, evidence_path, compare_url, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      incidentId,
      attempt,
      branch || null,
      result || null,
      evidence_path || null,
      compare_url || null,
      meta == null ? null : JSON.stringify(meta),
    );
  return database.prepare(`SELECT * FROM fix_attempts WHERE id = ?`).get(info.lastInsertRowid);
}

/** Merge a lab outcome into the incident's latest fix attempt row (no new attempt). */
export function updateLatestFixAttempt(incidentId, { result, metaPatch = {} } = {}) {
  const database = getDb();
  const row = database
    .prepare(`SELECT * FROM fix_attempts WHERE incident_id = ? ORDER BY attempt DESC, id DESC LIMIT 1`)
    .get(incidentId);
  if (!row) return null;
  let meta = {};
  try {
    meta = row.meta_json ? JSON.parse(row.meta_json) : {};
  } catch {
    meta = {};
  }
  database
    .prepare(`UPDATE fix_attempts SET result = ?, meta_json = ? WHERE id = ?`)
    .run(result || row.result, JSON.stringify({ ...meta, ...metaPatch }), row.id);
  return database.prepare(`SELECT * FROM fix_attempts WHERE id = ?`).get(row.id);
}

export function listFixAttempts(incidentId) {
  return getDb()
    .prepare(
      `SELECT * FROM fix_attempts WHERE incident_id = ? ORDER BY attempt ASC`,
    )
    .all(incidentId);
}

export function nextFixAttemptNumber(incidentId) {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(MAX(attempt), 0) AS n FROM fix_attempts WHERE incident_id = ?`,
    )
    .get(incidentId);
  return Number(row?.n || 0) + 1;
}

function groupByIncident(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.incident_id)) out.set(r.incident_id, []);
    out.get(r.incident_id).push(r);
  }
  return out;
}

/** All events for many incidents in one query → Map(incident_id → rows ASC). */
export function listEventsForIncidents(ids) {
  const list = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!list.length) return new Map();
  const rows = getDb()
    .prepare(
      `SELECT * FROM incident_events WHERE incident_id IN (SELECT value FROM json_each(?)) ORDER BY id ASC`,
    )
    .all(JSON.stringify(list));
  return groupByIncident(rows);
}

/** All fix attempts for many incidents → Map(incident_id → rows by attempt). */
export function listFixAttemptsForIncidents(ids) {
  const list = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!list.length) return new Map();
  const rows = getDb()
    .prepare(
      `SELECT * FROM fix_attempts WHERE incident_id IN (SELECT value FROM json_each(?)) ORDER BY incident_id, attempt ASC`,
    )
    .all(JSON.stringify(list));
  return groupByIncident(rows);
}

/**
 * Cheap change watermarks for live updates: max event / attempt ids and the
 * latest incident update. Every mutation path bumps at least one of them.
 */
export function getWatermarks() {
  const r = getDb()
    .prepare(
      `SELECT (SELECT COALESCE(MAX(id), 0) FROM incident_events) AS ev,
              (SELECT COALESCE(MAX(id), 0) FROM fix_attempts) AS fa,
              (SELECT COALESCE(MAX(updated_at), '') FROM incidents) AS up,
              (SELECT COUNT(*) FROM incidents) AS n`,
    )
    .get();
  return { ev: Number(r.ev), fa: Number(r.fa), up: String(r.up || ""), n: Number(r.n) };
}

/** Incident ids touched after the given watermarks (capped). */
export function incidentIdsChangedSince(w, limit = 200) {
  const rows = getDb()
    .prepare(
      `SELECT incident_id AS id FROM incident_events WHERE id > ?
       UNION SELECT incident_id FROM fix_attempts WHERE id > ?
       UNION SELECT id FROM incidents WHERE updated_at > ?
       LIMIT ?`,
    )
    .all(Number(w.ev) || 0, Number(w.fa) || 0, String(w.up || ""), limit + 1);
  return rows.map((r) => Number(r.id));
}
