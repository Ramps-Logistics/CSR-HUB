/* Supabase runtime for the Ramps Sponsorship Hub.
   The hub was built on claude.ai, where the page asks for its services through window.claude.use(...).
   This file provides the same services backed by Supabase, so hub.html runs unchanged:
     db         saved records (table hub_docs), with live updates
     user       who is signed in and their role (table members)
     assets     attachments (storage bucket "attachments")
     sample     Claude reading and writing (edge function "claude"; the API key stays on the server)
     downloads  saving files to the computer
   Load order in hub.html: supabase-js, config.js, this file, then the hub's own script. */
(function () {
  "use strict";
  const CFG = window.HUB_CONFIG || {};
  if (!window.supabase || !CFG.supabaseUrl || /YOUR-/.test(CFG.supabaseUrl + CFG.supabaseAnonKey)) {
    console.warn("Sponsorship Hub: Supabase isn't configured yet. Fill in config.js.");
    return; // window.claude stays undefined, so the hub opens view-only with its own notice
  }
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  window.hubSupabase = sb;
  const SIGN_IN_PAGE = "index.html";
  const BUCKET = "attachments";

  const err = (code, message) => Object.assign(new Error(message || code), { code });
  const collectionOf = path => path.replace(/\/[^/]+$/, "");
  const idOf = path => path.slice(path.lastIndexOf("/") + 1);
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, "");

  /* ---------- sign-in gate ---------- */
  const ready = (async () => {
    const { data } = await sb.auth.getSession();
    const session = data && data.session;
    if (!session) { location.replace(SIGN_IN_PAGE); throw err("signed_out"); }
    const { data: me } = await sb.from("members").select("user_id,email,name,role").eq("user_id", session.user.id).maybeSingle();
    return { session, me: me || null };
  })();
  sb.auth.onAuthStateChange(ev => { if (ev === "SIGNED_OUT") location.replace(SIGN_IN_PAGE); });

  /* ---------- db ---------- */
  const listeners = new Set(); // {kind:"doc"|"col", path, cb, onErr}
  const snapDoc = (path, row) => ({ id: idOf(path), exists: !!row, data: () => (row ? row.data : undefined), metadata: { fromCache: false } });
  const snapCol = rows => ({ docs: rows.map(r => ({ id: idOf(r.path), data: () => r.data })), metadata: { fromCache: false } });

  async function refresh(l) {
    let snap;
    try {
      if (l.kind === "doc") {
        const { data, error } = await sb.from("hub_docs").select("path,data").eq("path", l.path).maybeSingle();
        if (error) throw error;
        snap = snapDoc(l.path, data);
      } else {
        const { data, error } = await sb.from("hub_docs").select("path,data").eq("collection", l.path).order("path");
        if (error) throw error;
        snap = snapCol(data || []);
      }
    } catch (e) {
      console.error("Sponsorship Hub: couldn't load " + l.path + ":", e && (e.message || e), e && e.code ? "(code " + e.code + ")" : "", e && e.hint ? "Hint: " + e.hint : "");
      if (l.live && l.onErr) l.onErr(err("unavailable", e && e.message));
      return;
    }
    if (!l.live) return;
    try { l.cb(snap); }
    catch (e) { console.error("Sponsorship Hub: the page couldn't show " + l.path + ":", e); }
  }
  let channel = null;
  function ensureChannel() {
    if (channel) return;
    channel = sb.channel("hub_docs")
      .on("postgres_changes", { event: "*", schema: "public", table: "hub_docs" }, payload => {
        const path = (payload.new && payload.new.path) || (payload.old && payload.old.path);
        listeners.forEach(l => {
          if (!path || (l.kind === "doc" && l.path === path) || (l.kind === "col" && l.path === collectionOf(path))) refresh(l);
        });
      })
      .subscribe(status => { if (status === "SUBSCRIBED") listeners.forEach(refresh); });
  }
  function listen(kind, path, cb, onErr) {
    const l = { kind, path, cb, onErr, live: true };
    listeners.add(l); ensureChannel(); refresh(l);
    return () => { l.live = false; listeners.delete(l); };
  }
  const touch = path => listeners.forEach(l => { if ((l.kind === "doc" && l.path === path) || (l.kind === "col" && l.path === collectionOf(path))) refresh(l); });
  const dbErr = e => { const c = e && (e.code === "42501" || /row-level security|permission/i.test(e.message || "")) ? "invalid_argument" : e && e.code === "P0002" ? "not_found" : "unavailable"; return err(c, e && e.message); };

  const db = {
    doc(path) {
      return {
        id: idOf(path),
        onSnapshot: (cb, onErr) => listen("doc", path, cb, onErr),
        async get() { const { data, error } = await sb.from("hub_docs").select("path,data").eq("path", path).maybeSingle(); if (error) throw dbErr(error); return snapDoc(path, data); },
        async set(data) { const { error } = await sb.from("hub_docs").upsert({ path, data }); if (error) throw dbErr(error); touch(path); },
        async update(patch) { const { error } = await sb.rpc("hub_merge", { p_path: path, p_patch: patch }); if (error) throw dbErr(error); touch(path); },
        async delete() { const { error } = await sb.from("hub_docs").delete().eq("path", path); if (error) throw dbErr(error); touch(path); }
      };
    },
    collection(path) {
      return {
        onSnapshot: (cb, onErr) => listen("col", path, cb, onErr),
        doc: id => db.doc(path + "/" + id),
        async add(data) { const id = newId(); const { error } = await sb.from("hub_docs").insert({ path: path + "/" + id, data }); if (error) throw dbErr(error); touch(path + "/" + id); return { id }; }
      };
    }
  };

  /* ---------- user ---------- */
  const user = {
    id: async () => (await ready).session.user.id,
    canEdit: async () => { const { me } = await ready; return !!me && me.role === "admin"; },
    can: async what => { const { me } = await ready; if (!me) return false; return what === "data.write" ? me.role !== "viewer" : true; },
    async profiles(ids) {
      const out = {}; if (!ids || !ids.length) return out;
      const { data } = await sb.from("members").select("user_id,name,email").in("user_id", ids);
      (data || []).forEach(m => { out[m.user_id] = { name: m.name || m.email }; });
      return out;
    }
  };

  /* ---------- attachments ---------- */
  const signed = new Map(); // id -> {url, until}
  async function signedUrl(id) {
    const hit = signed.get(id); if (hit && hit.until > Date.now()) return hit.url;
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(id, 3600);
    if (error) throw err("not_found", error.message);
    signed.set(id, { url: data.signedUrl, until: Date.now() + 50 * 60 * 1000 });
    return data.signedUrl;
  }
  const assets = {
    async upload(file, opts) {
      const type = (opts && opts.type) || file.type || "application/octet-stream";
      const ext = ((file.name || "").match(/\.[A-Za-z0-9]{1,8}$/) || [""])[0].toLowerCase();
      const id = newId() + ext;
      const { error } = await sb.storage.from(BUCKET).upload(id, file, { contentType: type, upsert: false });
      if (error) throw err("upload_failed", error.message);
      return { id, contentType: type, url: "/_blob/" + id };
    },
    async delete(id) { const { error } = await sb.storage.from(BUCKET).remove([id]); if (error) throw err("delete_failed", error.message); signed.delete(id); }
  };
  // The hub points at attachments as "/_blob/<id>" (claude.ai's address for them). Translate those here:
  const BLOB = /^\/_blob\/([^?#]+)/;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const u = typeof input === "string" ? input : input && input.url;
    const m = u && BLOB.exec(u.replace(location.origin, ""));
    if (m) { const { data, error } = await sb.storage.from(BUCKET).download(decodeURIComponent(m[1])); return error ? new Response(null, { status: 404 }) : new Response(data, { status: 200 }); }
    return realFetch(input, init);
  };
  function fixNode(el) {
    if (el.tagName === "IMG") { const m = BLOB.exec(el.getAttribute("src") || ""); if (m) { el.removeAttribute("src"); signedUrl(decodeURIComponent(m[1])).then(u => { el.src = u; }).catch(() => {}); } }
  }
  new MutationObserver(muts => muts.forEach(mu => mu.addedNodes.forEach(n => { if (n.nodeType !== 1) return; fixNode(n); n.querySelectorAll && n.querySelectorAll("img[src^='/_blob/']").forEach(fixNode); })))
    .observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("click", e => {
    const a = e.target.closest && e.target.closest("a[href^='/_blob/']");
    if (a) {
      e.preventDefault();
      const w = window.open("about:blank", "_blank");
      signedUrl(decodeURIComponent(BLOB.exec(a.getAttribute("href"))[1])).then(u => { if (w) w.location = u; else location.href = u; }).catch(() => { if (w) w.close(); });
      return;
    }
    const so = e.target.closest && e.target.closest("#signOut");
    if (so) { e.preventDefault(); sb.auth.signOut().finally(() => location.replace(SIGN_IN_PAGE)); }
  }, true);

  /* ---------- downloads ---------- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: /\.csv$/i.test(filename) ? "text/csv" : /\.html?$/i.test(filename) ? "text/html" : "application/octet-stream" });
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = filename || "download"; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return { saved: true };
    }
  };

  /* ---------- Claude (through the "claude" edge function) ---------- */
  const MAX_IMAGES = 4;
  const toB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
  async function callClaude(prompt, opts, wantJson) {
    opts = opts || {};
    const { session } = await ready;
    const { data: fresh } = await sb.auth.getSession();
    const token = (fresh && fresh.session ? fresh.session : session).access_token;
    const images = [];
    for (const b of (opts.images || []).slice(0, MAX_IMAGES)) if (b) images.push({ media_type: b.type || "image/jpeg", data: await toB64(b) });
    let res;
    try {
      res = await realFetch(CFG.supabaseUrl + "/functions/v1/claude", {
        method: "POST", signal: opts.signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, apikey: CFG.supabaseAnonKey },
        body: JSON.stringify({ prompt: String(prompt), images, json: !!wantJson, tier: opts.modelTier === "quick" ? "quick" : "default" })
      });
    } catch (e) { if (e && e.name === "AbortError") throw err("cancelled"); throw err("network", e && e.message); }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw err(out.code || (res.status === 429 ? "rate_limited" : "sampling_failed"), out.message);
    return out;
  }
  const sample = async (prompt, opts) => { const o = await callClaude(prompt, opts, false); return { text: o.text || "" }; };
  sample.json = async (prompt, opts) => { const o = await callClaude(prompt, opts, true); if (o.json === undefined) throw err("invalid_json"); return o.json; };
  sample.limits = async () => ({ images: { maxCount: MAX_IMAGES } });

  /* ---------- the window.claude shape the hub expects ---------- */
  const services = { db, user, assets, sample, downloads };
  window.claude = {
    async use(name) {
      try { await ready; } catch (e) { return null; }
      return services[name] || null;
    }
  };
})();
