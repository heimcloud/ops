/**
 * Heimcloud Ops — incident ingest API + Tinyauth-gated admin UI.
 */
import express from "express";
import { getDb, getDbPath, upsertIncident } from "./lib/db.js";
import { createAdminRouter, getAdminConfig } from "./lib/admin.js";
import { getGithubTokenConfigured, getAllowlist } from "./lib/github.js";

const PORT = Number(process.env.PORT || 3000);
const OPS_INGEST_SECRET = (process.env.OPS_INGEST_SECRET || "").trim();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.static(new URL("./public", import.meta.url).pathname));

function requireIngestSecret(req, res, next) {
  if (!OPS_INGEST_SECRET) {
    return res.status(503).json({ error: "ops_ingest_not_configured" });
  }
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const header = String(req.headers["x-ops-secret"] || "").trim();
  if (bearer !== OPS_INGEST_SECRET && header !== OPS_INGEST_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return next();
}

app.get("/health", (_req, res) => {
  try {
    getDb();
    res.json({
      ok: true,
      service: "heimcloud-ops",
      db: getDbPath(),
      ingestConfigured: Boolean(OPS_INGEST_SECRET),
      githubConfigured: getGithubTokenConfigured(),
      allowlist: getAllowlist(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.get("/", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Heimcloud Ops</title>
<link rel="stylesheet" href="/css/ops.css"/></head>
<body>
<header class="site-header"><a class="logo" href="/">Heimcloud Ops</a>
<nav><a href="/admin">Admin</a><a href="/health">Health</a></nav></header>
<main>
  <section class="hero">
    <h1>Heimcloud Ops</h1>
    <p class="lead">Incident ingest + admin. Phase 1 — no Hermes client, no auto-fix, no auto-merge.</p>
    <p><a class="btn" href="/admin">Open admin</a></p>
    <div class="card">
      <p class="muted">Ingest: <code>POST /api/incidents</code> with <code>Authorization: Bearer …</code> or <code>X-Ops-Secret</code>.</p>
    </div>
  </section>
</main>
</body></html>`);
});

app.post("/api/incidents", requireIngestSecret, (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { incident, created } = upsertIncident(body);
    return res.status(created ? 201 : 200).json({
      ok: true,
      created,
      incident: {
        id: incident.id,
        report_hash: incident.report_hash,
        status: incident.status,
        class: incident.class,
        severity: incident.severity,
        target_hint: incident.target_hint,
        created_at: incident.created_at,
      },
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("[ingest]", err);
    return res.status(status).json({ error: err.message || "ingest_failed" });
  }
});

const { ADMIN_ENABLED, ADMIN_PATH, ADMIN_READ_ONLY } = getAdminConfig();
if (ADMIN_ENABLED) {
  const adminRouter = createAdminRouter();
  app.use(ADMIN_PATH, adminRouter);
}

// Ensure DB migrates on boot
getDb();

app.listen(PORT, () => {
  console.log(
    `Heimcloud ops listening on :${PORT} (ingest=${Boolean(OPS_INGEST_SECRET)}, github=${getGithubTokenConfigured()}, admin=${ADMIN_ENABLED ? ADMIN_PATH : "off"}, readOnly=${ADMIN_READ_ONLY}, db=${getDbPath()})`,
  );
});
