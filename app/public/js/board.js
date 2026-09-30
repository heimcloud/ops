/* Ops kanban board: progressive enhancement over the server-rendered board.
   Native HTML5 drag and drop + "Move to…" select (keyboard/touch), filters
   persisted in URL (wins) + localStorage, linkable drawer (#incident-N),
   optimistic moves with rollback. No dependencies. */
(() => {
  "use strict";
  const cfgEl = document.getElementById("board-config");
  if (!cfgEl) return;
  const cfg = JSON.parse(cfgEl.textContent);
  document.documentElement.classList.add("js");
  const root = document.querySelector(".board-wrap");
  const board = root.querySelector("[data-board]");
  const form = root.querySelector("form.filters");
  const drawer = root.querySelector("#drawer");
  const drawerInner = root.querySelector("[data-drawer-inner]");
  const backdrop = root.querySelector("[data-drawer-backdrop]");
  const toasts = root.querySelector("[data-toasts]");
  const LS_KEY = "ops.board.filters.v1";
  const FILTER_KEYS = ["q", "sev", "class", "unit", "repo", "mine", "cols"];
  const ALL_COLS = cfg.columns.map((c) => c.key);
  const label = (s) => cfg.labels[s] || s;

  // ------------------------------------------------------------ toasts
  function toast(msg, kind = "info", ms = 4200) {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.setAttribute("role", kind === "err" ? "alert" : "status");
    el.textContent = msg;
    toasts.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  // Flash from a no-JS redirect: show once as a toast, then clean the URL.
  (() => {
    const u = new URL(location.href);
    const msg = u.searchParams.get("msg");
    const err = u.searchParams.get("err");
    if (!msg && !err) return;
    root.querySelectorAll(":scope > .alert.ok, :scope > .alert.warn:not(.ro-banner)").forEach((a) => {
      if (!/Read-only/.test(a.textContent)) a.remove();
    });
    toast(err || msg, err ? "err" : "ok");
    u.searchParams.delete("msg");
    u.searchParams.delete("err");
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
  })();

  // ------------------------------------------------------ transitions
  function allowed(from, to) {
    return (cfg.transitions[from] || []).includes(to);
  }
  function refusal(from, to) {
    if (cfg.workerOwned.includes(to)) return `${label(to)} is set by the host worker. Use "Start fix" instead.`;
    const ok = (cfg.transitions[from] || []).map(label).join(", ") || "nothing";
    return `Can't move #card from ${label(from)} to ${label(to)}. Allowed: ${ok}.`;
  }
  function colKeyOf(status) {
    const c = cfg.columns.find((x) => x.statuses.includes(status));
    return c ? c.key : "open";
  }
  /** Status a drop on this zone means (Done body: resolved, else closed). */
  function zoneStatus(zone, from) {
    const d = zone.dataset.drop;
    if (d !== "done") return d;
    if (allowed(from, "resolved")) return "resolved";
    if (allowed(from, "closed")) return "closed";
    return "resolved";
  }
  function bodyFor(status) {
    return board.querySelector(`.kcol[data-col="${colKeyOf(status)}"] .kcol-body`);
  }

  // -------------------------------------------------------------- API
  async function send(url, body) {
    let r;
    try {
      r = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body || {}),
      });
    } catch {
      throw Object.assign(new Error("Network error; nothing changed."), { data: null });
    }
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      throw Object.assign(new Error(r.status === 403 ? "Refused (read-only or cross-origin)." : "Session expired? Reload the page."), { data: null });
    }
    const data = await r.json();
    if (!r.ok || !data.ok) throw Object.assign(new Error(data.message || `HTTP ${r.status}`), { data });
    return data;
  }

  // ------------------------------------------------------------ cards
  function place(card) {
    const body = bodyFor(card.dataset.status);
    if (!body) return;
    if (card.parentElement !== body) body.prepend(card);
  }
  function replaceCard(oldCard, html, { flash = true } = {}) {
    if (!html) return oldCard;
    const tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    const fresh = tpl.content.firstElementChild;
    if (!fresh) return oldCard;
    const target = bodyFor(fresh.dataset.status);
    if (oldCard && oldCard.isConnected) {
      if (oldCard.parentElement === target) oldCard.replaceWith(fresh);
      else {
        oldCard.remove();
        target.prepend(fresh);
      }
    } else target.prepend(fresh);
    if (oldCard && oldCard.classList.contains("selected")) fresh.classList.add("selected");
    wireCard(fresh);
    applyFilters(state, { persist: false });
    if (flash) {
      fresh.classList.add("flash");
      setTimeout(() => fresh.classList.remove("flash"), 900);
    }
    return fresh;
  }
  function cardById(id) {
    return board.querySelector(`.kcard[data-id="${id}"]`);
  }

  async function move(card, to) {
    const id = card.dataset.id;
    const from = card.dataset.status;
    if (!to || from === to) return;
    if (!allowed(from, to)) {
      toast(refusal(from, to).replace("#card", `#${id}`), "warn");
      card.classList.add("shake");
      setTimeout(() => card.classList.remove("shake"), 400);
      resetSelect(card);
      return;
    }
    // Optimistic: move now, roll back on error.
    const parent = card.parentElement;
    const next = card.nextElementSibling;
    card.dataset.status = to;
    place(card);
    card.classList.add("pending");
    updateCounts();
    try {
      const data = await send(`${cfg.base}/incidents/${id}`, { action: "move", status: to, expect_from: from });
      replaceCard(card, data.card_html);
      toast(`#${id}: ${label(from)} → ${label(to)}`, "ok", 2500);
      refreshDrawerIf(id);
    } catch (e) {
      card.dataset.status = from;
      if (next && next.parentElement === parent) parent.insertBefore(card, next);
      else parent.appendChild(card);
      card.classList.remove("pending");
      resetSelect(card);
      if (e.data && e.data.card_html) replaceCard(card, e.data.card_html);
      updateCounts();
      toast(`#${id} not moved: ${e.message}`, "err", 6000);
    }
  }
  function resetSelect(card) {
    const sel = card && card.querySelector(".move-select");
    if (sel) sel.selectedIndex = 0;
  }

  // ------------------------------------------------------ drag & drop
  let dragCard = null;
  let lastDenied = null;
  function markZones(from) {
    board.querySelectorAll(".kcol").forEach((col) => {
      const statuses = col.dataset.statuses.split(",");
      const home = statuses.includes(from);
      const ok = !home && statuses.some((s) => allowed(from, s));
      col.classList.toggle("home", home);
      col.classList.toggle("can-drop", ok);
      col.classList.toggle("no-drop", !ok && !home);
    });
    board.querySelectorAll(".dropzone.sub").forEach((z) => {
      const ok = from !== z.dataset.drop && allowed(from, z.dataset.drop);
      z.classList.toggle("can-drop", ok);
      z.classList.toggle("no-drop", !ok);
    });
  }
  function clearZones() {
    root.classList.remove("is-dragging");
    board.querySelectorAll(".can-drop,.no-drop,.home,.over").forEach((el) => el.classList.remove("can-drop", "no-drop", "home", "over"));
  }
  function zoneTarget(el) {
    const sub = el.closest(".dropzone.sub");
    if (sub) return { zone: sub, status: sub.dataset.drop };
    const col = el.closest(".kcol");
    if (!col) return null;
    const zone = col.querySelector(".kcol-body");
    return { zone, status: zoneStatus(zone, dragCard ? dragCard.dataset.status : "") };
  }

  if (!cfg.readOnly) {
    board.addEventListener("dragstart", (ev) => {
      const card = ev.target.closest && ev.target.closest(".kcard[draggable]");
      if (!card) return;
      dragCard = card;
      lastDenied = null;
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", `#${card.dataset.id}`);
      requestAnimationFrame(() => {
        card.classList.add("is-drag");
        root.classList.add("is-dragging");
        markZones(card.dataset.status);
      });
    });
    board.addEventListener("dragover", (ev) => {
      if (!dragCard) return;
      const t = zoneTarget(ev.target);
      board.querySelectorAll(".over").forEach((el) => el.classList.remove("over"));
      if (!t) return;
      const from = dragCard.dataset.status;
      if (t.status === from || colKeyOf(t.status) === colKeyOf(from) && !t.zone.classList.contains("sub")) {
        lastDenied = null;
        return;
      }
      if (allowed(from, t.status)) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        t.zone.classList.add("over");
        lastDenied = null;
      } else {
        lastDenied = t.status;
      }
    });
    board.addEventListener("drop", (ev) => {
      if (!dragCard) return;
      ev.preventDefault();
      const t = zoneTarget(ev.target);
      const card = dragCard;
      dragCard = null;
      lastDenied = null;
      clearZones();
      card.classList.remove("is-drag");
      if (t) move(card, t.status);
    });
    board.addEventListener("dragend", () => {
      if (dragCard) {
        dragCard.classList.remove("is-drag");
        if (lastDenied) toast(refusal(dragCard.dataset.status, lastDenied).replace("#card", `#${dragCard.dataset.id}`), "warn");
      }
      dragCard = null;
      lastDenied = null;
      clearZones();
      flushDeferred();
    });
  }

  // --------------------------------------------- forms (move + actions)
  root.addEventListener("change", (ev) => {
    const sel = ev.target.closest(".move-select");
    if (!sel || !sel.value) return;
    const card = sel.closest(".kcard") || cardById(sel.closest("[data-drawer-id]")?.dataset.drawerId);
    if (card) move(card, sel.value);
    else sel.form.requestSubmit();
    if (!sel.closest(".kcard")) sel.selectedIndex = 0;
  });
  root.addEventListener("submit", async (ev) => {
    const f = ev.target;
    if (f === form) {
      ev.preventDefault();
      return;
    }
    if (!f.matches(".act-form, .move-form")) return;
    ev.preventDefault();
    if (f.matches(".move-form")) {
      const sel = f.querySelector(".move-select");
      const card = f.closest(".kcard") || cardById(f.closest("[data-drawer-id]")?.dataset.drawerId);
      if (card && sel.value) move(card, sel.value);
      return;
    }
    if (f.dataset.confirm && !window.confirm(f.dataset.confirm)) return;
    const btn = f.querySelector("button");
    const id = (f.getAttribute("action").match(/\/incidents\/(\d+)/) || [])[1];
    const body = Object.fromEntries(new FormData(f));
    delete body.return_to;
    if (btn) btn.disabled = true;
    try {
      const data = await send(f.getAttribute("action"), body);
      replaceCard(cardById(id), data.card_html);
      toast(`#${id}: ${data.message || "done"}`, "ok");
      refreshDrawerIf(id);
    } catch (e) {
      if (e.data && e.data.card_html) replaceCard(cardById(id), e.data.card_html);
      toast(`#${id}: ${e.message}`, "err", 7000);
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  });

  // ------------------------------------------------------------ filters
  function fromQuery(search) {
    const p = new URLSearchParams(search);
    const cols = p.getAll("cols").flatMap((v) => v.split(",")).filter((k) => ALL_COLS.includes(k));
    return {
      q: p.get("q") || "",
      sev: p.get("sev") || "",
      class: p.get("class") || "",
      unit: p.get("unit") || "",
      repo: p.get("repo") || "",
      mine: ["1", "true", "on"].includes(p.get("mine") || ""),
      cols: cols.length ? [...new Set(cols)] : null,
    };
  }
  function toQuery(s) {
    const p = new URLSearchParams();
    for (const k of ["q", "sev", "class", "unit", "repo"]) if (s[k]) p.set(k, s[k]);
    if (s.mine) p.set("mine", "1");
    if (s.cols && s.cols.length < ALL_COLS.length) p.set("cols", s.cols.join(","));
    const q = p.toString();
    return q ? `?${q}` : "";
  }
  function readForm() {
    const fd = new FormData(form);
    const cols = fd.getAll("cols");
    return {
      q: String(fd.get("q") || "").trim(),
      sev: fd.get("sev") || "",
      class: fd.get("class") || "",
      unit: fd.get("unit") || "",
      repo: fd.get("repo") || "",
      mine: fd.get("mine") === "1",
      cols: cols.length === ALL_COLS.length ? null : cols,
    };
  }
  function setSelect(name, v) {
    const el = form.elements[name];
    if (!el) return;
    if (v && ![...el.options].some((o) => o.value === v)) {
      const o = new Option(v, v);
      el.add(o);
    }
    el.value = v || "";
  }
  function writeForm(s) {
    form.elements.q.value = s.q || "";
    for (const k of ["sev", "class", "unit", "repo"]) setSelect(k, s[k]);
    form.elements.mine.checked = Boolean(s.mine);
    form.querySelectorAll('input[name="cols"]').forEach((c) => {
      c.checked = !s.cols || s.cols.includes(c.value);
    });
  }
  function matches(card, s) {
    const d = card.dataset;
    if (s.sev && d.sev !== s.sev) return false;
    if (s.class && d.class !== s.class) return false;
    if (s.unit && d.unit !== s.unit) return false;
    if (s.repo && d.repo !== s.repo) return false;
    if (s.mine && d.needed !== "1") return false;
    if (s.q) {
      const hay = d.search || "";
      if (!s.q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t))) return false;
    }
    return true;
  }
  function updateCounts() {
    board.querySelectorAll(".kcol").forEach((col) => {
      const cards = [...col.querySelectorAll(".kcard")];
      const shown = cards.filter((c) => !c.hidden).length;
      const cnt = col.querySelector("[data-col-count]");
      if (cnt) cnt.textContent = shown === cards.length ? String(cards.length) : `${shown}/${cards.length}`;
      const need = col.querySelector("[data-col-need]");
      if (need) {
        const n = cards.filter((c) => c.dataset.needed === "1").length;
        need.textContent = n ? `${n} need input` : "";
        need.classList.toggle("need", n > 0);
      }
      if (col.dataset.col === "done") {
        const sub = col.querySelector(".col-sub");
        const r = cards.filter((c) => c.dataset.status === "resolved").length;
        if (sub) sub.textContent = `${r} resolved · ${cards.length - r} closed`;
      }
    });
    const total = board.querySelectorAll('.kcard[data-needed="1"]').length;
    const pill = form.querySelector("[data-need-total]");
    if (pill) pill.textContent = String(total);
  }
  let state = fromQuery("");
  function applyFilters(s, { persist = true } = {}) {
    state = s;
    board.querySelectorAll(".kcard").forEach((c) => {
      c.hidden = !matches(c, s);
    });
    board.querySelectorAll(".kcol").forEach((col) => {
      col.hidden = Boolean(s.cols) && !s.cols.includes(col.dataset.col);
    });
    const cc = form.querySelector("[data-cols-count]");
    if (cc) cc.textContent = `${s.cols ? s.cols.length : ALL_COLS.length}/${ALL_COLS.length}`;
    const reset = form.querySelector("[data-reset]");
    if (reset) reset.hidden = !toQuery(s);
    updateCounts();
    if (!persist) return;
    history.replaceState(history.state, "", location.pathname + toQuery(s) + location.hash);
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(s));
    } catch {
      /* private mode */
    }
  }
  (() => {
    const urlHas = [...new URLSearchParams(location.search).keys()].some((k) => FILTER_KEYS.includes(k));
    let s = fromQuery(location.search);
    if (!urlHas) {
      try {
        const saved = JSON.parse(localStorage.getItem(LS_KEY) || "null");
        if (saved && typeof saved === "object") s = { ...s, ...saved, cols: Array.isArray(saved.cols) ? saved.cols.filter((k) => ALL_COLS.includes(k)) : null };
        if (s.cols && !s.cols.length) s.cols = null;
      } catch {
        /* ignore */
      }
    }
    writeForm(s);
    applyFilters(s);
  })();
  let qTimer;
  form.addEventListener("input", (ev) => {
    clearTimeout(qTimer);
    if (ev.target.name === "q") qTimer = setTimeout(() => applyFilters(readForm()), 120);
    else applyFilters(readForm());
  });
  form.addEventListener("change", () => applyFilters(readForm()));
  form.querySelector("[data-reset]")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    const s = fromQuery("");
    writeForm(s);
    applyFilters(s);
  });
  document.addEventListener("click", (ev) => {
    const d = form.querySelector(".f-cols[open]");
    if (d && !d.contains(ev.target)) d.open = false;
  });

  // ------------------------------------------------------------- drawer
  let openId = null;
  let lastFocus = null;
  async function loadDrawer(id) {
    openId = id;
    if (!drawer.hidden && drawerInner.querySelector(`[data-drawer-id="${id}"]`)) {
      /* refresh in place */
    } else {
      lastFocus = document.activeElement;
      drawerInner.innerHTML = `<p class="muted" style="padding:1rem">Loading #${id}…</p>`;
    }
    drawer.hidden = false;
    backdrop.hidden = false;
    board.querySelectorAll(".kcard.selected").forEach((c) => c.classList.remove("selected"));
    cardById(id)?.classList.add("selected");
    try {
      const r = await fetch(`${cfg.base}/incidents/${id}/drawer?fragment=1`, { credentials: "same-origin" });
      if (!r.ok) throw new Error(r.status === 404 ? `Incident #${id} not found` : `HTTP ${r.status}`);
      if (openId !== id) return;
      drawerInner.innerHTML = await r.text();
      if (!drawer.contains(document.activeElement)) drawer.querySelector("[data-close]")?.focus({ preventScroll: true });
    } catch (e) {
      drawerInner.innerHTML = `<p class="muted" style="padding:1rem">${e.message}</p>`;
    }
  }
  function hideDrawer() {
    openId = null;
    drawer.hidden = true;
    backdrop.hidden = true;
    board.querySelectorAll(".kcard.selected").forEach((c) => c.classList.remove("selected"));
    if (lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
  }
  function closeDrawer() {
    if (/^#incident-\d+$/.test(location.hash)) history.pushState(null, "", location.pathname + location.search);
    hideDrawer();
  }
  function refreshDrawerIf(id) {
    if (String(openId) === String(id)) loadDrawer(String(id));
  }
  function syncHash() {
    const m = /^#incident-(\d+)$/.exec(location.hash);
    if (m) loadDrawer(m[1]);
    else if (!drawer.hidden) hideDrawer();
  }
  window.addEventListener("hashchange", syncHash);
  window.addEventListener("popstate", syncHash);
  function openCard(id) {
    const h = `#incident-${id}`;
    if (location.hash === h) loadDrawer(String(id));
    else {
      history.pushState(null, "", location.pathname + location.search + h);
      loadDrawer(String(id));
    }
  }
  board.addEventListener("click", (ev) => {
    const link = ev.target.closest("[data-open]");
    if (link) {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
      ev.preventDefault();
      openCard(link.dataset.open);
      return;
    }
    if (ev.target.closest("a, button, select, input, label, form, summary")) return;
    const card = ev.target.closest(".kcard");
    if (card) openCard(card.dataset.id);
  });
  drawer.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-close]")) {
      ev.preventDefault();
      closeDrawer();
    }
  });
  backdrop.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !drawer.hidden) {
      ev.preventDefault();
      closeDrawer();
    }
    if (ev.key === "/" && document.activeElement === document.body) {
      ev.preventDefault();
      form.elements.q.focus();
    }
  });

  function wireCard() {
    /* delegated handlers; hook kept for future per-card setup */
  }

  // ------------------------------------------------------- live updates
  // Cards the user is interacting with (dragging, optimistic move in flight,
  // focus in its Move-to select) are never replaced under them: their update
  // is deferred until the interaction ends.
  const deferred = new Set();
  let deferredDrawer = false;
  function busy(card) {
    if (!card) return false;
    if (card === dragCard || card.classList.contains("pending") || card.classList.contains("is-drag")) return true;
    const a = document.activeElement;
    return Boolean(a && card.contains(a) && a.matches("select, input, textarea"));
  }
  function flushDeferred() {
    if (deferred.size) {
      const ids = [...deferred];
      deferred.clear();
      patchCards(ids);
    }
    if (deferredDrawer && openId) {
      deferredDrawer = false;
      refreshDrawerLive(openId);
    }
  }
  root.addEventListener("focusout", () => setTimeout(flushDeferred, 0));

  async function patchCards(ids) {
    const q = ids === "all" ? "all" : [...new Set(ids.map(String))].join(",");
    if (!q) return;
    let data;
    try {
      const r = await fetch(`${cfg.base}/cards?ids=${encodeURIComponent(q)}`, { credentials: "same-origin", headers: { accept: "application/json" } });
      if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) return;
      data = await r.json();
    } catch {
      return;
    }
    const seen = new Set();
    for (const c of data.cards || []) {
      seen.add(String(c.id));
      const old = cardById(c.id);
      if (busy(old)) {
        deferred.add(String(c.id));
        continue;
      }
      // "all" = resync: only flash cards that actually moved/changed state.
      const changed = !old || old.dataset.status !== c.status || old.dataset.needed !== (c.needed ? "1" : "0");
      replaceCard(old, c.html, { flash: ids !== "all" || changed });
    }
    if (data.full) {
      board.querySelectorAll(".kcard").forEach((el) => {
        if (!seen.has(el.dataset.id) && !busy(el)) el.remove();
      });
    }
    decorateRunning(lastJob);
    updateCounts();
  }

  async function refreshDrawerLive(id) {
    const a = document.activeElement;
    if (a && drawer.contains(a) && a.matches("select, input, textarea")) {
      deferredDrawer = true;
      return;
    }
    let html;
    try {
      const r = await fetch(`${cfg.base}/incidents/${id}/drawer?fragment=1`, { credentials: "same-origin" });
      if (!r.ok) return;
      html = await r.text();
    } catch {
      return;
    }
    if (String(openId) !== String(id) || drawer.hidden) return;
    // Keep the reader where they are: scroll offset + expanded <details>.
    const top = drawer.scrollTop;
    const open = [...drawerInner.querySelectorAll("details")].map((d) => d.open);
    const pres = [...drawerInner.querySelectorAll("pre")].map((p) => p.scrollTop);
    drawerInner.innerHTML = html;
    drawerInner.querySelectorAll("details").forEach((d, i) => {
      if (i < open.length) d.open = open[i];
    });
    drawerInner.querySelectorAll("pre").forEach((p, i) => {
      if (i < pres.length) p.scrollTop = pres[i];
    });
    drawer.scrollTop = top;
  }

  const slot = root.querySelector("[data-worker-slot]");
  let lastJob = null;
  function decorateRunning(job) {
    board.querySelectorAll(".kc-run").forEach((el) => {
      if (!job || el.closest(".kcard")?.dataset.id !== String(job.incidentId)) el.remove();
    });
    if (!job || !job.incidentId) return;
    const card = cardById(job.incidentId);
    if (!card) return;
    let el = card.querySelector(".kc-run");
    if (!el) {
      el = document.createElement("div");
      el.className = "kc-run";
      el.dataset.run = "";
      el.innerHTML = `<i class="dot" aria-hidden="true"></i><span></span><span class="mono"></span>`;
      const actions = card.querySelector(".kc-actions");
      card.insertBefore(el, actions || null);
    }
    el.children[1].textContent = `${job.kind} · ${job.stageText}`;
    el.children[2].dataset.elapsedFrom = job.startedAt || "";
  }
  async function refreshWorker() {
    if (!slot) return;
    try {
      const r = await fetch(`${cfg.base}/worker.json`, { credentials: "same-origin", headers: { accept: "application/json" } });
      if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) return;
      const data = await r.json();
      const a = document.activeElement;
      const refocus = a && slot.contains(a) ? a.closest("form")?.getAttribute("action") : null;
      slot.innerHTML = data.worker_html;
      if (refocus) slot.querySelector(`form[action="${CSS.escape(refocus)}"] button`)?.focus({ preventScroll: true });
      lastJob = data.job;
      decorateRunning(lastJob);
    } catch {
      /* next change retries */
    }
  }
  if (slot) {
    const wp = slot.querySelector("[data-worker-panel]");
    if (wp && wp.dataset.jobIncident) {
      lastJob = { incidentId: Number(wp.dataset.jobIncident), kind: wp.dataset.jobKind || "", stageText: wp.dataset.jobStage, startedAt: Number(wp.dataset.jobStarted) || null };
    }
    slot.addEventListener("click", (ev) => {
      const link = ev.target.closest("[data-open]");
      if (!link || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
      ev.preventDefault();
      openCard(link.dataset.open);
    });
  }
  if (window.OpsLive) {
    window.OpsLive.on((p) => {
      if (p.incidents === "all" || (Array.isArray(p.incidents) && p.incidents.length)) {
        patchCards(p.incidents);
        if (openId && (p.incidents === "all" || p.incidents.map(String).includes(String(openId)))) refreshDrawerLive(openId);
      }
      if (p.worker) refreshWorker();
    });
  }
  syncHash();
})();
