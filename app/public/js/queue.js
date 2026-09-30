/* Queue & worker page: live refresh of the worker panel and queue tables
   (via OpsLive), never while the user has a priority select open/focused. */
(() => {
  "use strict";
  const cfgEl = document.getElementById("live-config");
  if (!cfgEl || !window.OpsLive) return;
  const cfg = JSON.parse(cfgEl.textContent);
  const wslot = document.querySelector("[data-worker-slot]");
  const qslot = document.querySelector("[data-queue-slot]");
  let deferred = false;
  let inflight = null;

  // Flash from a no-JS redirect: show as a toast, clean the URL.
  (() => {
    const u = new URL(location.href);
    const msg = u.searchParams.get("msg");
    const err = u.searchParams.get("err");
    if (!msg && !err) return;
    document.querySelectorAll(".queue-page > .alert.ok, .queue-page > .alert.warn").forEach((a) => {
      if (!/Read-only/.test(a.textContent)) a.remove();
    });
    window.OpsLive.toast(err || msg, err ? "err" : "ok");
    u.searchParams.delete("msg");
    u.searchParams.delete("err");
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
  })();

  function interacting() {
    const a = document.activeElement;
    return Boolean(a && qslot.contains(a) && a.matches("select"));
  }
  async function refresh() {
    if (interacting()) {
      deferred = true;
      return;
    }
    if (inflight) {
      deferred = true;
      return;
    }
    inflight = fetch(`${cfg.base}/worker.json?variant=full`, { credentials: "same-origin", headers: { accept: "application/json" } });
    try {
      const r = await inflight;
      if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) return;
      const data = await r.json();
      if (interacting()) {
        deferred = true;
        return;
      }
      const a = document.activeElement;
      const key = a && (wslot.contains(a) || qslot.contains(a)) ? focusKey(a) : null;
      wslot.innerHTML = data.worker_html;
      qslot.innerHTML = data.queue_html;
      if (key) restoreFocus(key);
    } catch {
      /* next change retries */
    } finally {
      inflight = null;
      if (deferred && !interacting()) {
        deferred = false;
        refresh();
      }
    }
  }
  // Re-focus the "same" control after a re-render (keyboard users).
  function focusKey(el) {
    const f = el.closest("form");
    if (!f) return null;
    const fields = [...f.querySelectorAll("input[type=hidden]")].map((i) => `${i.name}=${i.value}`).join("&");
    return `${f.getAttribute("action")}?${fields}`;
  }
  function restoreFocus(key) {
    for (const f of document.querySelectorAll("form[data-qaction]")) {
      if (focusKey(f.querySelector("button, select") || f) === key) {
        (f.querySelector("button, select") || f).focus({ preventScroll: true });
        return;
      }
    }
  }
  document.addEventListener("focusout", () =>
    setTimeout(() => {
      if (deferred && !interacting()) {
        deferred = false;
        refresh();
      }
    }, 0),
  );
  window.OpsLive.on(() => refresh());
})();
