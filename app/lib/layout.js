export function adminLayout({ title, body, basePath = "/admin", readOnly = false, lang = "en" }) {
  const base = String(basePath || "/admin").replace(/\/$/, "") || "/admin";
  const ro = readOnly
    ? `<span class="example-tag" title="Mutating forms disabled">read-only</span>`
    : "";
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · Ops Admin · Heimcloud</title>
  <link rel="stylesheet" href="/css/ops.css" />
</head>
<body>
  <header class="site-header">
    <a class="logo" href="${base}/">Heimcloud Ops</a>
    <nav>
      <a href="${base}/">Incidents</a>
      <a href="/health">Health</a>
      ${ro}
    </nav>
  </header>
  <main>${body}</main>
  <footer class="site-footer">
    <p>Ops admin · Tinyauth at edge · Ingest via shared secret · No auto-merge</p>
  </footer>
</body>
</html>`;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
