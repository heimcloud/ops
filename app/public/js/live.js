/* Live updates for the Ops admin (board + queue page). No dependencies.
   Server-Sent Events from <admin>/events; if EventSource is missing, keeps
   failing, or stays silent (a buffering proxy), falls back to polling
   <admin>/live.json every 5 s with If-None-Match (unchanged = bodiless 304)
   and retries SSE every 2 min. Pages subscribe with OpsLive.on(fn); payload
   = { rev, incidents: [ids] | "all", worker: bool }.
   Also: 1 s ticker for elapsed clocks + stale heartbeat display, and the
   JSON enhancement of queue action forms (form[data-qaction]). */
(() => {
  "use strict";
  const cfgEl = document.getElementById("live-config");
  if (!cfgEl) return;
  const cfg = JSON.parse(cfgEl.textContent);
  const base = cfg.base;
  let rev = cfg.rev || "";
  const subs = [];
  const ind = document.querySelector("[data-live]");
  const POLL_MS = 5000;
  const SILENCE_MS = 40000; // server pings every 15 s

  function setState(state, text, title) {
    if (!ind) return;
    ind.dataset.state = state;
    const t = ind.querySelector("[data-live-text]");
    if (t) t.textContent = text;
    ind.title = title || text;
  }

  function emit(p) {
    if (p && p.rev) rev = p.rev;
    const hasChange = p && (p.worker || p.incidents === "all" || (Array.isArray(p.incidents) && p.incidents.length));
    if (!hasChange) return;
    for (const fn of subs) {
      try {
        fn(p);
      } catch (e) {
        console.error(e);
      }
    }
  }

  let es = null;
  let errors = 0;
  let silenceTimer = null;
  let pollTimer = null;
  let retrySseTimer = null;
  let etag = null;
  let mode = "sse";

  function armSilence() {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      // Connected but nothing arrives: a proxy is buffering the stream.
      if (es) es.close();
      es = null;
      startPolling("no data on the event stream (proxy buffering?)");
    }, SILENCE_MS);
  }

  function startSse() {
    clearTimeout(pollTimer);
    clearTimeout(retrySseTimer);
    if (!("EventSource" in window)) return startPolling("EventSource unsupported");
    mode = "sse";
    errors = 0;
    setState("connecting", "Connecting…");
    es = new EventSource(`${base}/events?rev=${encodeURIComponent(rev)}`);
    // First message must arrive quickly (the server sends one immediately).
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (es) es.close();
      es = null;
      startPolling("event stream sent nothing (proxy buffering?)");
    }, 10000);
    const alive = () => {
      errors = 0;
      setState("live", "Live", "Live updates (server-sent events)");
      armSilence();
    };
    es.addEventListener("hello", alive);
    es.addEventListener("ping", alive);
    es.addEventListener("change", (ev) => {
      alive();
      try {
        emit(JSON.parse(ev.data));
      } catch (e) {
        console.error(e);
      }
    });
    es.addEventListener("error", () => {
      errors += 1;
      if (!es || es.readyState === 2 || errors >= 4) {
        if (es) es.close();
        es = null;
        startPolling("event stream unavailable");
      } else {
        setState("reconnecting", "Reconnecting…", "Event stream dropped; reconnecting");
      }
    });
  }

  function startPolling(reason) {
    clearTimeout(silenceTimer);
    mode = "poll";
    setState("polling", "Live (polling)", `Polling every 5 s: ${reason}`);
    const poll = async () => {
      if (mode !== "poll") return;
      try {
        const headers = { accept: "application/json" };
        if (etag) headers["if-none-match"] = etag;
        const r = await fetch(`${base}/live.json?rev=${encodeURIComponent(rev)}`, { credentials: "same-origin", cache: "no-store", headers });
        if (r.status === 304) {
          setState("polling", "Live (polling)", `Polling every 5 s: ${reason}`);
        } else if (r.ok && (r.headers.get("content-type") || "").includes("json")) {
          etag = r.headers.get("etag");
          emit(await r.json());
          setState("polling", "Live (polling)", `Polling every 5 s: ${reason}`);
        } else {
          setState("reconnecting", "Reconnecting…", r.status === 401 || r.status === 403 ? "Session expired? Reload the page." : `HTTP ${r.status}`);
        }
      } catch {
        setState("reconnecting", "Reconnecting…", "Network error");
      }
      pollTimer = setTimeout(poll, document.hidden ? POLL_MS * 3 : POLL_MS);
    };
    clearTimeout(pollTimer);
    poll();
    clearTimeout(retrySseTimer);
    retrySseTimer = setTimeout(() => {
      if (mode === "poll") startSse();
    }, 120000);
  }

  // ------------------------------------------------------------ clocks
  const skew = typeof cfg.now === "number" ? cfg.now - Date.now() : 0;
  const now = () => Date.now() + skew;
  function dur(sec) {
    const s = Math.max(0, Math.floor(sec));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
    return `${Math.floor(h / 24)}d`;
  }
  function tickClocks() {
    document.querySelectorAll("[data-elapsed-from]").forEach((el) => {
      const t = Number(el.dataset.elapsedFrom);
      if (t) el.textContent = dur((now() - t) / 1000);
    });
    const wp = document.querySelector("[data-worker-panel]");
    if (!wp) return;
    const hb = Number(wp.dataset.hb);
    const age = hb ? (now() - hb) / 1000 : null;
    const hbEl = wp.querySelector("[data-hb-age]");
    if (hbEl && age != null) hbEl.textContent = dur(age);
    if (wp.dataset.state === "running") {
      const stale = age == null || age > Number(wp.dataset.staleAfter || 300);
      if (stale && wp.dataset.display !== "stale") {
        wp.dataset.display = "stale";
        wp.className = wp.className.replace(/\bst-\S+/g, "").trim() + " st-stale";
        const t = wp.querySelector("[data-state-text]");
        if (t) t.textContent = "Stale";
        const pill = wp.querySelector("[data-state-pill]");
        if (pill) pill.title = `Worker says running but its heartbeat is ${age == null ? "missing" : dur(age)} old.`;
      }
    }
  }
  setInterval(tickClocks, 1000);

  // ------------------------------------------------------------ toasts + actions
  function toast(msg, kind = "info", ms = 4200) {
    const box = document.querySelector("[data-toasts]");
    if (!box) return;
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.setAttribute("role", kind === "err" ? "alert" : "status");
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }
  async function post(url, body) {
    let r;
    try {
      r = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body || {}),
      });
    } catch {
      throw new Error("Network error; nothing changed.");
    }
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("application/json")) throw new Error(r.status === 403 ? "Refused (read-only or cross-origin)." : "Session expired? Reload the page.");
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.message || `HTTP ${r.status}`);
    return data;
  }
  document.addEventListener("submit", async (ev) => {
    const f = ev.target.closest && ev.target.closest("form[data-qaction]");
    if (!f) return;
    ev.preventDefault();
    if (f.dataset.confirm && !window.confirm(f.dataset.confirm)) return;
    const body = Object.fromEntries(new FormData(f));
    delete body.return_to;
    const btns = f.querySelectorAll("button, select");
    btns.forEach((b) => (b.disabled = true));
    try {
      const data = await post(f.getAttribute("action"), body);
      toast(data.message || "Done", "ok");
    } catch (e) {
      toast(e.message, "err", 7000);
    } finally {
      btns.forEach((b) => b.isConnected && (b.disabled = false));
      // Refresh right away instead of waiting for the next tick.
      emit({ rev, incidents: [], worker: true, local: true });
    }
  });
  document.addEventListener("change", (ev) => {
    const sel = ev.target.closest && ev.target.closest("select[data-autosubmit]");
    if (sel && sel.form) sel.form.requestSubmit();
  });

  window.OpsLive = {
    on(fn) {
      subs.push(fn);
    },
    rev: () => rev,
    mode: () => mode,
    toast,
    now,
  };
  document.documentElement.classList.add("js");
  startSse();
  window.addEventListener("pagehide", () => {
    if (es) es.close();
  });
})();
