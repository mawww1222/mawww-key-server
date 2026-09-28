//========================================================--
// MAWWWHUB KEY SYSTEM - Backend
//========================================================--
const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

//========================================================--
// DATABASE
//========================================================--
const DB_PATH = process.env.DB_PATH || "./data/database.db";
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(DB_PATH);

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

db.exec(`
    CREATE TABLE IF NOT EXISTS keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        hwid TEXT DEFAULT NULL,
        duration_type TEXT DEFAULT 'permanent',
        duration_days INTEGER DEFAULT 0,
        expires_at INTEGER DEFAULT NULL,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        status TEXT DEFAULT 'active',
        note TEXT DEFAULT '',
        used_count INTEGER DEFAULT 0
    );
`);

//========================================================--
// CONFIG
//========================================================--
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const DISCORD_LINK = process.env.DISCORD_LINK || "https://discord.gg/yourlink";

//========================================================--
// HELPERS
//========================================================--
function generateKey() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let key = "MAWWW";
    for (let g = 0; g < 4; g++) {
        key += "-";
        for (let i = 0; i < 4; i++) key += chars[Math.floor(Math.random() * chars.length)];
    }
    return key;
}

function durationToSeconds(type, days) {
    if (type === "permanent") return null;
    const d = parseInt(days) || 0;
    return d * 24 * 60 * 60;
}

function authAdmin(req, res, next) {
    const pass = req.headers["x-admin-pass"] || req.query.admin_pass;
    if (!pass || pass !== ADMIN_PASSWORD) {
        return res.status(401).json({ ok: false, msg: "Unauthorized" });
    }
    next();
}

//========================================================--
// PUBLIC ROUTES
//========================================================--
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

app.get("/api/info", (req, res) => {
    res.json({ ok: true, service: "MawwwHub", discord: DISCORD_LINK });
});

app.get("/health", (req, res) => res.json({ ok: true, time: Date.now() }));

//========================================================--
// VALIDATE KEY (untuk Roblox)
//========================================================--
app.get("/api/validate", (req, res) => {
    const { key, hwid } = req.query;
    if (!key) return res.json({ ok: false, msg: "No key provided" });
    if (!hwid) return res.json({ ok: false, msg: "No HWID provided" });

    const entry = db.prepare("SELECT * FROM keys WHERE key = ?").get(key.toUpperCase());
    if (!entry) return res.json({ ok: false, msg: "Key tidak terdaftar" });
    if (entry.status !== "active") return res.json({ ok: false, msg: "Key tidak aktif" });
    if (entry.expires_at && entry.expires_at < Math.floor(Date.now() / 1000)) {
        return res.json({ ok: false, msg: "Key expired" });
    }

    // Bind HWID kalau belum
    if (!entry.hwid) {
        db.prepare("UPDATE keys SET hwid = ?, used_count = used_count + 1 WHERE id = ?")
          .run(hwid, entry.id);
        return res.json({
            ok: true,
            msg: "Key bound",
            type: entry.duration_type,
            expires_at: entry.expires_at
        });
    }

    if (entry.hwid !== hwid) {
        return res.json({ ok: false, msg: "Key sudah dipakai device lain" });
    }

    db.prepare("UPDATE keys SET used_count = used_count + 1 WHERE id = ?").run(entry.id);
    return res.json({
        ok: true,
        msg: "Key valid",
        type: entry.duration_type,
        expires_at: entry.expires_at
    });
});

//========================================================--
// ADMIN: LOGIN CHECK
//========================================================--
app.post("/api/admin/login", (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) return res.json({ ok: true });
    return res.json({ ok: false, msg: "Password salah" });
});

//========================================================--
// ADMIN: GENERATE KEY
//========================================================--
app.post("/api/admin/generate", authAdmin, (req, res) => {
    const { duration_type, duration_days, quantity, note } = req.body;
    const qty = Math.min(parseInt(quantity) || 1, 100);
    const secs = durationToSeconds(duration_type, duration_days);
    const expiresAt = secs ? Math.floor(Date.now() / 1000) + secs : null;

    const created = [];
    for (let i = 0; i < qty; i++) {
        let newKey, attempts = 0;
        while (attempts < 10) {
            newKey = generateKey();
            const dup = db.prepare("SELECT id FROM keys WHERE key = ?").get(newKey);
            if (!dup) break;
            attempts++;
        }
        db.prepare(
            "INSERT INTO keys (key, duration_type, duration_days, expires_at, note) VALUES (?, ?, ?, ?, ?)"
        ).run(newKey, duration_type || "permanent", parseInt(duration_days) || 0, expiresAt, note || "");
        created.push(newKey);
    }

    res.json({ ok: true, keys: created, count: created.length });
});

//========================================================--
// ADMIN: LIST KEYS
//========================================================--
app.get("/api/admin/keys", authAdmin, (req, res) => {
    const { search, status } = req.query;
    let query = "SELECT * FROM keys";
    const params = [];
    const conditions = [];

    if (search) {
        conditions.push("(key LIKE ? OR hwid LIKE ? OR note LIKE ?)");
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status && status !== "all") {
        conditions.push("status = ?");
        params.push(status);
    }
    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY created_at DESC LIMIT 500";

    const keys = db.prepare(query).all(...params);

    // Stats
    const stats = {
        total: db.prepare("SELECT COUNT(*) as c FROM keys").get().c,
        active: db.prepare("SELECT COUNT(*) as c FROM keys WHERE status = 'active'").get().c,
        bound: db.prepare("SELECT COUNT(*) as c FROM keys WHERE hwid IS NOT NULL").get().c,
        permanent: db.prepare("SELECT COUNT(*) as c FROM keys WHERE duration_type = 'permanent'").get().c,
    };

    res.json({ ok: true, keys, stats });
});

//========================================================--
// ADMIN: DELETE KEY
//========================================================--
app.delete("/api/admin/delete/:id", authAdmin, (req, res) => {
    db.prepare("DELETE FROM keys WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
});

//========================================================--
// ADMIN: RESET HWID
//========================================================--
app.post("/api/admin/reset/:id", authAdmin, (req, res) => {
    db.prepare("UPDATE keys SET hwid = NULL WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
});

//========================================================--
// ADMIN: TOGGLE STATUS
//========================================================--
app.post("/api/admin/toggle/:id", authAdmin, (req, res) => {
    const entry = db.prepare("SELECT * FROM keys WHERE id = ?").get(req.params.id);
    if (!entry) return res.json({ ok: false });
    const newStatus = entry.status === "active" ? "disabled" : "active";
    db.prepare("UPDATE keys SET status = ? WHERE id = ?").run(newStatus, req.params.id);
    res.json({ ok: true, status: newStatus });
});

//========================================================--
// ADMIN: EXTEND KEY
//========================================================--
app.post("/api/admin/extend/:id", authAdmin, (req, res) => {
    const { days } = req.body;
    const entry = db.prepare("SELECT * FROM keys WHERE id = ?").get(req.params.id);
    if (!entry) return res.json({ ok: false, msg: "Key not found" });

    const addSecs = (parseInt(days) || 0) * 24 * 60 * 60;
    const now = Math.floor(Date.now() / 1000);
    const base = entry.expires_at && entry.expires_at > now ? entry.expires_at : now;
    const newExpiry = base + addSecs;

    db.prepare("UPDATE keys SET expires_at = ?, duration_type = 'days' WHERE id = ?")
      .run(newExpiry, req.params.id);
    res.json({ ok: true, expires_at: newExpiry });
});

//========================================================--
// START
//========================================================--
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 MawwwHub Key System on port ${PORT}`);
    console.log(`📁 Database: ${DB_PATH}`);
});
