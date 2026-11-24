import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5";
const BOOTSTRAP_ADMINS = new Set(
  String(process.env.CSR_BOOTSTRAP_ADMINS || "ved.mahadeo@rampslogistics.com,rae-anne.richardson@rampslogistics.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && /sslmode=require/i.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hub_docs (
      path TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS hub_docs_collection_idx ON hub_docs (collection);

    CREATE TABLE IF NOT EXISTS hub_assets (
      id TEXT PRIMARY KEY,
      content_type TEXT NOT NULL,
      data BYTEA NOT NULL,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS hub_members (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'contributor',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function collectionOf(docPath) {
  const idx = docPath.lastIndexOf("/");
  return idx >= 0 ? docPath.slice(0, idx) : "";
}

function idOf(docPath) {
  const idx = docPath.lastIndexOf("/");
  return idx >= 0 ? docPath.slice(idx + 1) : docPath;
}

function resolveIdentity(req) {
  const emailRaw =
    req.headers["x-wot-user-email"] ||
    req.headers["x-forwarded-email"] ||
    req.headers["x-auth-request-email"] ||
    req.headers["x-ms-client-principal-name"] ||
    req.headers["x-user-email"] ||
    "";
  const email = String(Array.isArray(emailRaw) ? emailRaw[0] : emailRaw).trim().toLowerCase();
  const nameRaw =
    req.headers["x-wot-user-name"] ||
    req.headers["x-forwarded-user"] ||
    req.headers["x-auth-request-user"] ||
    "";
  const name = String(Array.isArray(nameRaw) ? nameRaw[0] : nameRaw).trim();
  const fallbackName = email ? email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Ramps Team Member";
  return {
    email: email || "team@rampslogistics.com",
    name: name && !name.includes("@") ? name : fallbackName,
  };
}

async function resolveMember(req) {
  const { email, name } = resolveIdentity(req);
  const { rows } = await pool.query("SELECT email, name, role FROM hub_members WHERE email = $1", [email]);
  if (rows.length) {
    const m = rows[0];
    if (BOOTSTRAP_ADMINS.has(email) && m.role !== "admin") {
      await pool.query("UPDATE hub_members SET role = 'admin', updated_at = now() WHERE email = $1", [email]);
      m.role = "admin";
    }
    return { id: m.email, email: m.email, name: m.name, role: m.role };
  }
  const role = BOOTSTRAP_ADMINS.has(email) ? "admin" : "contributor";
  await pool.query(
    "INSERT INTO hub_members (email, name, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING",
    [email, name, role]
  );
  return { id: email, email, name, role };
}

function extractJsonObject(rawText) {
  const trimmed = String(rawText || "").trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw new Error("Claude response did not contain a valid JSON object.");
  }
}

// Prepare hub.html once in memory: swap Supabase scripts for wot-runtime.js & rename Poppi -> Chance
const rawHubHtml = fs.readFileSync(path.join(__dirname, "hub.html"), "utf8");
const hubHtml = rawHubHtml
  .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]*"><\/script>\s*/g, "")
  .replace(/<script src="config\.js"><\/script>\s*/g, "")
  .replace(/<script src="supabase-runtime\.js"><\/script>/g, '<script src="/wot-runtime.js"></script>')
  .replace(/\bPoppi\b/g, "Chance");

const app = express();
app.disable("x-powered-by");

app.get("/health", (_req, res) => {
  res.json({ ok: true, model: CLAUDE_MODEL, anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY) });
});

app.get(["/", "/hub.html", "/index.html"], (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(hubHtml);
});

app.get("/wot-runtime.js", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "wot-runtime.js"));
});

app.get("/favicon.svg", (_req, res) => res.sendFile(path.join(__dirname, "favicon.svg")));
app.get("/ramps-logo.webp", (_req, res) => res.sendFile(path.join(__dirname, "ramps-logo.webp")));

app.use("/api/assets", express.raw({ type: () => true, limit: "25mb" }));
app.use(express.json({ limit: "25mb" }));

app.get("/api/me", async (req, res) => {
  try {
    const me = await resolveMember(req);
    res.json(me);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/profiles", async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.json({});
    const { rows } = await pool.query("SELECT email, name FROM hub_members WHERE email = ANY($1::text[])", [ids]);
    const out = {};
    for (const r of rows) out[r.email] = { name: r.name || r.email };
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/doc", async (req, res) => {
  try {
    const docPath = String(req.query.path || "");
    if (!docPath) return res.status(400).json({ error: "Missing path" });
    const { rows } = await pool.query("SELECT path, data FROM hub_docs WHERE path = $1", [docPath]);
    if (!rows.length) return res.json({ exists: false, path: docPath });
    res.json({ exists: true, path: rows[0].path, data: rows[0].data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/collection", async (req, res) => {
  try {
    const colPath = String(req.query.path || "");
    if (!colPath) return res.status(400).json({ error: "Missing path" });
    const { rows } = await pool.query("SELECT path, data FROM hub_docs WHERE collection = $1 ORDER BY path", [colPath]);
    res.json({ docs: rows.map((r) => ({ id: idOf(r.path), path: r.path, data: r.data })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/doc", async (req, res) => {
  try {
    const me = await resolveMember(req);
    if (me.role === "viewer") return res.status(403).json({ error: "Read-only role" });
    const docPath = String(req.body?.path || "");
    const data = req.body?.data;
    if (!docPath || data === undefined) return res.status(400).json({ error: "Missing path or data" });
    await pool.query(
      `INSERT INTO hub_docs (path, collection, data, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [docPath, collectionOf(docPath), JSON.stringify(data)]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/doc", async (req, res) => {
  try {
    const me = await resolveMember(req);
    if (me.role === "viewer") return res.status(403).json({ error: "Read-only role" });
    const docPath = String(req.body?.path || "");
    const patch = req.body?.patch;
    if (!docPath || !patch || typeof patch !== "object") return res.status(400).json({ error: "Missing path or patch" });
    const { rowCount } = await pool.query(
      `UPDATE hub_docs SET data = data || $2::jsonb, updated_at = now() WHERE path = $1`,
      [docPath, JSON.stringify(patch)]
    );
    if (!rowCount) {
      await pool.query(
        `INSERT INTO hub_docs (path, collection, data, updated_at) VALUES ($1, $2, $3::jsonb, now())`,
        [docPath, collectionOf(docPath), JSON.stringify(patch)]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/collection", async (req, res) => {
  try {
    const me = await resolveMember(req);
    if (me.role === "viewer") return res.status(403).json({ error: "Read-only role" });
    const colPath = String(req.body?.path || "");
    const data = req.body?.data;
    if (!colPath || data === undefined) return res.status(400).json({ error: "Missing path or data" });
    const id = crypto.randomUUID().replace(/-/g, "");
    const docPath = `${colPath}/${id}`;
    await pool.query(
      `INSERT INTO hub_docs (path, collection, data, updated_at) VALUES ($1, $2, $3::jsonb, now())`,
      [docPath, colPath, JSON.stringify(data)]
    );
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/doc", async (req, res) => {
  try {
    const me = await resolveMember(req);
    if (me.role !== "admin") return res.status(403).json({ error: "Admin role required" });
    const docPath = String(req.query.path || "");
    if (!docPath) return res.status(400).json({ error: "Missing path" });
    await pool.query("DELETE FROM hub_docs WHERE path = $1", [docPath]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/assets", async (req, res) => {
  try {
    const me = await resolveMember(req);
    if (me.role === "viewer") return res.status(403).json({ error: "Read-only role" });
    const contentType = String(req.headers["content-type"] || "application/octet-stream").split(";")[0].trim();
    const filename = decodeURIComponent(String(req.headers["x-filename"] || "attachment"));
    const ext = (filename.match(/\.[A-Za-z0-9]{1,8}$/) || [""])[0].toLowerCase();
    const id = crypto.randomUUID().replace(/-/g, "") + ext;
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
    await pool.query(
      "INSERT INTO hub_assets (id, content_type, data, created_by) VALUES ($1, $2, $3, $4)",
      [id, contentType, buf, me.email]
    );
    res.json({ id, contentType, url: "/_blob/" + id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/assets/:id", async (req, res) => {
  try {
    const me = await resolveMember(req);
    if (me.role === "viewer") return res.status(403).json({ error: "Read-only role" });
    await pool.query("DELETE FROM hub_assets WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/_blob/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT content_type, data FROM hub_assets WHERE id = $1", [req.params.id]);
    if (!rows.length) return res.status(404).send("Not found");
    res.setHeader("Content-Type", rows[0].content_type || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(rows[0].data);
  } catch (e) {
    res.status(500).send("Error loading attachment");
  }
});

app.post("/api/claude", async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ code: "sampling_failed", message: "ANTHROPIC_API_KEY is not configured." });

    const prompt = String(req.body?.prompt || "");
    const wantJson = Boolean(req.body?.json);
    const images = Array.isArray(req.body?.images) ? req.body.images.slice(0, 4) : [];

    const content = [
      ...images
        .filter((img) => img && typeof img.data === "string" && img.data)
        .map((img) => ({
          type: "image",
          source: { type: "base64", media_type: img.media_type || "image/jpeg", data: img.data },
        })),
      { type: "text", text: prompt },
    ];

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        temperature: 0.1,
        messages: [{ role: "user", content }],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      return res.status(resp.status === 429 ? 429 : 502).json({
        code: resp.status === 429 ? "rate_limited" : "sampling_failed",
        message: `Anthropic API error (${resp.status}): ${detail.slice(0, 240)}`,
      });
    }

    const body = await resp.json();
    const text = (body.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (wantJson) {
      return res.json({ text, json: extractJsonObject(text) });
    }
    res.json({ text });
  } catch (e) {
    res.status(500).json({ code: "sampling_failed", message: e.message });
  }
});

migrate()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[csr-hub-wot] listening on :${PORT}, model=${CLAUDE_MODEL}`);
    });
  })
  .catch((err) => {
    console.error("[csr-hub-wot] failed to migrate:", err);
    process.exit(1);
  });
