/**
 * Admin UI — list incidents, set class, Create draft PR.
 * Edge auth: Tinyauth via SWAG (admin.auth). In-app: ADMIN_ENABLED / ADMIN_READ_ONLY.
 */
import { Router } from "express";
import { adminLayout, escapeHtml } from "./layout.js";
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
} from "./db.js";
import {
  createDraftPrForIncident,
  getGithubTokenConfigured,
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

  router.get("/", (req, res) => {
    const statusFilter = String(req.query.status || "").trim() || null;
    const incidents = listIncidents({
      status: statusFilter && getStatuses().includes(statusFilter) ? statusFilter : null,
    });
    const counts = countByStatus();
    const base = req.adminBase;
    const ghOk = getGithubTokenConfigured();

    const rows = incidents
      .map(
        (i) => `<tr>
        <td><a href="${base}/incidents/${i.id}">#${i.id}</a></td>
        <td><code>${escapeHtml((i.report_hash || "").slice(0, 12))}…</code></td>
        <td>${escapeHtml(i.severity || "—")}</td>
        <td>${escapeHtml(i.status)}</td>
        <td>${escapeHtml(i.class)}</td>
        <td class="muted">${escapeHtml(i.target_repo || i.target_hint || "—")}</td>
        <td class="muted">${escapeHtml(i.created_at || "")}</td>
      </tr>`,
      )
      .join("");

    const statusLinks = ["", ...getStatuses()]
      .map((s) => {
        const href = s ? `${base}/?status=${encodeURIComponent(s)}` : `${base}/`;
        const label = s || "all";
        const active = (statusFilter || "") === s;
        return `<a class="btn ${active ? "" : "secondary"}" href="${href}" style="margin:0.2rem">${label}${s ? ` (${counts[s] || 0})` : ""}</a>`;
      })
      .join(" ");

    res.type("html").send(
      adminLayout({
        title: "Incidents",
        basePath: base,
        readOnly: ADMIN_READ_ONLY,
        body: `
        <h1>Incidents</h1>
        ${readOnlyBanner()}
        ${flash(req.query)}
        ${
          ghOk
            ? ""
            : `<div class="alert warn"><strong>GITHUB_TOKEN / GH_TOKEN not set.</strong> Create PR will return 503 until configured.</div>`
        }
        <div class="grid grid-2">
          ${getStatuses()
            .map(
              (s) =>
                `<div class="card"><p class="muted">${s}</p><p class="price" style="font-size:1.4rem">${counts[s] || 0}</p></div>`,
            )
            .join("")}
        </div>
        <p>${statusLinks}</p>
        <p class="muted">Allowlist: <code>${escapeHtml(getAllowlist().join(", "))}</code></p>
        ${table(
          ["ID", "Hash", "Severity", "Status", "Class", "Target", "Created"],
          rows,
        )}
        `,
      }),
    );
  });

  router.get("/incidents/:id", (req, res) => {
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
        <form method="post" action="${base}/incidents/${id}/create-pr" class="card" onsubmit="return confirm('Open a draft PR shell on ${escapeHtml(resolved)}?');">
          <p>Creates branch <code>heimcloud/incident-${id}</code> on <strong>${escapeHtml(resolved)}</strong>,
             commits a checklist stub under <code>docs/heimcloud-ops/</code>, and opens a <strong>draft</strong> PR. No auto-merge.</p>
          <button class="btn" type="submit" ${getGithubTokenConfigured() ? "" : "disabled"}>Create PR</button>
          ${
            incident.draft_pr_url
              ? `<p style="margin-top:0.75rem">Existing: <a href="${escapeHtml(incident.draft_pr_url)}" target="_blank" rel="noopener">${escapeHtml(incident.draft_pr_url)}</a></p>`
              : ""
          }
        </form>`;

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
        ${mutate}
        <h2>Events</h2>
        ${table(["ID", "Kind", "Message", "Created"], eventRows)}
        <p><a href="${base}/">← Incidents</a></p>
        `,
      }),
    );
  });

  router.post("/incidents/:id", (req, res) => {
    const base = req.adminBase;
    if (refuseMutations(res, base)) return;
    const id = Number(req.params.id);
    try {
      const updated = updateIncident(id, {
        class: String(req.body.class || "").trim(),
        status: String(req.body.status || "").trim(),
        target_repo: String(req.body.target_repo || "").trim() || null,
      });
      if (!updated) return res.status(404).send("Not found");
      addIncidentEvent(id, "admin_update", "Class/status/target updated", {
        class: updated.class,
        status: updated.status,
        target_repo: updated.target_repo,
      });
      return res.redirect(
        303,
        `${base}/incidents/${id}?msg=${encodeURIComponent("Incident updated")}`,
      );
    } catch (err) {
      console.error("[admin] update", err);
      return res.redirect(
        303,
        `${base}/incidents/${id}?err=${encodeURIComponent(err.message || "Update failed")}`,
      );
    }
  });

  router.post("/incidents/:id/create-pr", async (req, res) => {
    const base = req.adminBase;
    if (refuseMutations(res, base)) return;
    const id = Number(req.params.id);
    const incident = getIncident(id);
    if (!incident) return res.status(404).send("Not found");
    try {
      const result = await createDraftPrForIncident(incident);
      updateIncident(id, {
        status: "pr_opened",
        target_repo: result.repo,
        draft_pr_url: result.pr_url,
        draft_pr_number: result.pr_number,
        draft_branch: result.branch,
      });
      addIncidentEvent(id, "draft_pr", result.reused ? "Reused open draft PR" : "Opened draft PR", result);
      const msg = result.reused
        ? `Reused draft PR #${result.pr_number}`
        : `Opened draft PR #${result.pr_number}`;
      return res.redirect(
        303,
        `${base}/incidents/${id}?msg=${encodeURIComponent(msg)}`,
      );
    } catch (err) {
      console.error("[admin] create-pr", err);
      addIncidentEvent(id, "draft_pr_error", err.message || "Create PR failed", {
        status: err.status,
        data: err.data || null,
      });
      return res.redirect(
        303,
        `${base}/incidents/${id}?err=${encodeURIComponent(err.message || "Create PR failed")}`,
      );
    }
  });

  // Silence unused import warning for getDb if tree-shaken oddly — keep for parity / future
  void getDb;

  return router;
}

export function getAdminConfig() {
  return { ADMIN_ENABLED, ADMIN_PATH, ADMIN_READ_ONLY };
}
