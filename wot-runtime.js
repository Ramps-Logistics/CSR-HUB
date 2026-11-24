/* WOT runtime for the Ramps Sponsorship Hub.
   Provides the exact window.claude.use(...) surface expected by hub.html,
   backed by Express + Postgres + Anthropic Claude on WOT. */
(function () {
  "use strict";

  const err = (code, message) => Object.assign(new Error(message || code), { code });
  const collectionOf = path => path.replace(/\/[^/]+$/, "");
  const idOf = path => path.slice(path.lastIndexOf("/") + 1);
  const realFetch = window.fetch.bind(window);

  async function apiJson(url, opts) {
    let res;
    try {
      res = await realFetch(url, {
        credentials: "same-origin",
        ...opts,
        headers: { "Content-Type": "application/json", ...(opts && opts.headers ? opts.headers : {}) }
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw err("cancelled");
      throw err("network", e && e.message);
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = out.code || (res.status === 401 ? "signed_out" : res.status === 403 ? "invalid_argument" : res.status === 404 ? "not_found" : res.status === 429 ? "rate_limited" : "unavailable");
      throw err(code, out.message || out.error || `HTTP ${res.status}`);
    }
    return out;
  }

  /* ---------- user ---------- */
  let mePromise = null;
  function getMe() {
    if (!mePromise) mePromise = apiJson("/api/me", { method: "GET" });
    return mePromise;
  }

  const user = {
    id: async () => (await getMe()).id,
    canEdit: async () => (await getMe()).role === "admin",
    can: async what => {
      const me = await getMe();
      if (!me) return false;
      return what === "data.write" ? me.role !== "viewer" : true;
    },
    async profiles(ids) {
      if (!ids || !ids.length) return {};
      return apiJson("/api/profiles", { method: "POST", body: JSON.stringify({ ids }) });
    }
  };

  /* ---------- db ---------- */
  const listeners = new Set(); // { kind: "doc"|"col", path, cb, onErr, live }
  const snapDoc = (path, row) => ({
    id: idOf(path),
    exists: !!(row && row.exists),
    data: () => (row && row.exists ? row.data : undefined),
    metadata: { fromCache: false }
  });
  const snapCol = rows => ({
    docs: (rows || []).map(r => ({ id: r.id || idOf(r.path), data: () => r.data })),
    metadata: { fromCache: false }
  });

  async function refresh(l) {
    let snap;
    try {
      if (l.kind === "doc") {
        const res = await apiJson("/api/doc?path=" + encodeURIComponent(l.path), { method: "GET" });
        snap = snapDoc(l.path, res);
      } else {
        const res = await apiJson("/api/collection?path=" + encodeURIComponent(l.path), { method: "GET" });
        snap = snapCol(res.docs || []);
      }
    } catch (e) {
      if (l.live && l.onErr) l.onErr(err("unavailable", e && e.message));
      return;
    }
    if (!l.live) return;
    try { l.cb(snap); } catch (e) { console.error("Sponsorship Hub render error for " + l.path + ":", e); }
  }

  let pollTimer = null;
  function ensurePoll() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") listeners.forEach(l => refresh(l));
    }, 20000);
  }

  function listen(kind, path, cb, onErr) {
    const l = { kind, path, cb, onErr, live: true };
    listeners.add(l);
    ensurePoll();
    refresh(l);
    return () => { l.live = false; listeners.delete(l); };
  }

  const touch = path => {
    const jobs = [];
    listeners.forEach(l => {
      if ((l.kind === "doc" && l.path === path) || (l.kind === "col" && l.path === collectionOf(path))) {
        jobs.push(refresh(l));
      }
    });
    return Promise.race([Promise.all(jobs), new Promise(r => setTimeout(r, 4000))]);
  };

  const db = {
    doc(path) {
      return {
        id: idOf(path),
        onSnapshot: (cb, onErr) => listen("doc", path, cb, onErr),
        async get() {
          const res = await apiJson("/api/doc?path=" + encodeURIComponent(path), { method: "GET" });
          return snapDoc(path, res);
        },
        async set(data) {
          await apiJson("/api/doc", { method: "PUT", body: JSON.stringify({ path, data }) });
          await touch(path);
        },
        async update(patch) {
          await apiJson("/api/doc", { method: "PATCH", body: JSON.stringify({ path, patch }) });
          await touch(path);
        },
        async delete() {
          await apiJson("/api/doc?path=" + encodeURIComponent(path), { method: "DELETE" });
          await touch(path);
        }
      };
    },
    collection(path) {
      return {
        onSnapshot: (cb, onErr) => listen("col", path, cb, onErr),
        doc: id => db.doc(path + "/" + id),
        async add(data) {
          const res = await apiJson("/api/collection", { method: "POST", body: JSON.stringify({ path, data }) });
          await touch(path + "/" + res.id);
          return { id: res.id };
        }
      };
    }
  };

  /* ---------- attachments ---------- */
  const assets = {
    async upload(file, opts) {
      const type = (opts && opts.type) || file.type || "application/octet-stream";
      const res = await realFetch("/api/assets", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": type,
          "X-Filename": encodeURIComponent(file.name || "attachment")
        },
        body: file
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw err("upload_failed", out.message || out.error || `HTTP ${res.status}`);
      return out; // { id, contentType, url: "/_blob/" + id }
    },
    async delete(id) {
      await apiJson("/api/assets/" + encodeURIComponent(id), { method: "DELETE" });
    }
  };

  /* ---------- downloads ---------- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob
        ? data
        : new Blob([data], {
            type: /\.csv$/i.test(filename)
              ? "text/csv"
              : /\.html?$/i.test(filename)
                ? "text/html"
                : "application/octet-stream"
          });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return { saved: true };
    }
  };

  /* ---------- Claude ---------- */
  const MAX_IMAGES = 4;
  const toB64 = blob => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });

  async function callClaude(prompt, opts, wantJson) {
    opts = opts || {};
    const images = [];
    for (const b of (opts.images || []).slice(0, MAX_IMAGES)) {
      if (b) images.push({ media_type: b.type || "image/jpeg", data: await toB64(b) });
    }
    return apiJson("/api/claude", {
      method: "POST",
      signal: opts.signal,
      body: JSON.stringify({
        prompt: String(prompt),
        images,
        json: !!wantJson,
        tier: opts.modelTier === "quick" ? "quick" : "default"
      })
    });
  }

  const sample = async (prompt, opts) => {
    const o = await callClaude(prompt, opts, false);
    return { text: o.text || "" };
  };
  sample.json = async (prompt, opts) => {
    const o = await callClaude(prompt, opts, true);
    if (o.json === undefined) throw err("invalid_json");
    return o.json;
  };
  sample.limits = async () => ({ images: { maxCount: MAX_IMAGES } });

  /* ---------- expose window.claude ---------- */
  const services = { db, user, assets, sample, downloads };
  window.claude = {
    async use(name) {
      await getMe();
      return services[name] || null;
    }
  };
})();
