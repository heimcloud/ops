/**
 * SQLite (better-sqlite3) with WAL + foreign keys.
 * Path: OPS_DB_PATH (default /data/ops.sqlite).
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.OPS_DB_PATH || "/data/ops.sqlite";

const STATUSES = ["open", "triaged", "pr_opened", "resolved", "closed"];
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
  database.exec(`
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
        CHECK (status IN ('open', 'triaged', 'pr_opened', 'resolved', 'closed')),
      class TEXT NOT NULL DEFAULT 'unknown'
        CHECK (class IN ('software', 'human_config', 'unknown')),
      draft_pr_url TEXT,
      draft_pr_number INTEGER,
      draft_branch TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS incident_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      message TEXT,
      meta_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
    CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_incident_events_incident ON incident_events(incident_id);
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

  const now = new Date().toISOString();
  database
    .prepare(
      `UPDATE incidents SET
         status = ?, class = ?, target_repo = ?,
         draft_pr_url = ?, draft_pr_number = ?, draft_branch = ?,
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
      now,
      id,
    );

  return database.prepare(`SELECT * FROM incidents WHERE id = ?`).get(id);
}

export function countByStatus() {
  const rows = getDb()
    .prepare(
      `SELECT status, COUNT(*) AS n FROM incidents GROUP BY status`,
    )
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

