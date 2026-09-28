//========================================================--
// MAWWW KEY SYSTEM - Backend API (Railway Ready)
//========================================================--
const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

//========================================================--
// DATABASE PATH (Railway Volume)
//========================================================--
const DB_PATH = process.env.DB_PATH || "./data/database.db";
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}
const db = new Database(DB_PATH);

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

//========================================================--
// DATABASE SETUP
//========================================================--
db.exec(`
    CREATE TABLE IF NOT EXISTS keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        hwid TEXT DEFAULT NULL,
        expires_at INTEGER DEFAULT NULL,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        status TEXT DEFAULT 'active',
        used_count INTEGER DEFAULT 0
    );
    
    CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        api_key TEXT UNIQUE NOT NULL
    );
`);

//========================================================--
// ADMIN DEFAULT
//========================================================--
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "changeme123";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "mawww_secret_key_" + crypto.randomBytes(8).toString("hex");

const adminExists = db.prepare("SELECT * FROM admins WHERE username = ?").get(ADMIN_USER);
if (!adminExists) {
    db.prepare("INSERT INTO admins (username, password, api_key) VALUES (?, ?, ?)")
      .run(ADMIN_USER, crypto.createHash("sha256").update(ADMIN_PASS).digest("hex"), ADMIN_API_KEY);
    console.log("✅ Admin created. API Key: " + ADMIN_API_KEY);
} else {
    console.log("✅ Admin exists. API Key: " + adminExists.api_key);
}

//========================================================--
// HELPERS
//========================================================--
function generateKey() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let key = "MAWWW";
    for (let g = 0; g < 4; g++) {
        key += "-";
        for (let i = 0; i < 4; i++) {
            key += chars[Math.floor(Math.random() * chars.length)];
        }
    }
    return key;
}

function authAdmin(req, res, next) {
    const token = req.headers["x-api-key"] || req.query.api_key;
    if (!token) return res.status(401).json({ ok: false, msg: "No API key" });
    const admin = db.prepare("SELECT * FROM admins WHERE api_key = ?").get(token);
    if (!admin) return res.status(403).json({ ok: false, msg: "Invalid API key" });
    req.admin = admin;
    next();
}

//========================================================--
// HEALTH CHECK (Railway ping)
//========================================================--
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/health", (req, res) => {
    res.json({ ok: true, status: "alive", time: Date.now() });
});

//========================================================--
// VALIDATE KEY (dipanggil Roblox)
//========================================================--
app.get("/api/validate", (req, res) => {
    const { key, hwid } = req.query;

    if (!key) return res.json({ ok: false, msg: "No key provided" });
    if (!hwid) return res.json({ ok: false, msg: "No HWID provided" });

    const entry = db.prepare("SELECT * FROM keys WHERE key = ?").get(key.toUpperCase());

    if (!entry) return res.json({ ok: false, msg: "Key tidak terdaftar" });
    if (entry.status !== "active") return res.json({ ok: false, msg: "Key tidak aktif" });

    if (entry.expires_at && entry.expires_at < Math.floor(Date.now() / 1000)) {
        return res.json({ ok: false, msg: "Key sudah expired" });
    }

    if (!entry.hwid) {
        db.prepare("UPDATE keys SET hwid = ?, used_count = used_count + 1 WHERE id = ?")
          .run(hwid, entry.id);
        return res.json({ ok: true, msg: "Key bound ke device ini" });
    }

    if (entry.hwid !== hwid) {
        return res.json({ ok: false, msg: "Key sudah dipakai device lain" });
    }

    db.prepare("UPDATE keys SET used_count = used_count + 1 WHERE id = ?").run(entry.id);
    return res.json({ ok: true, msg: "Key valid" });
});

//========================================================--
// GET KEY (untuk user)
//========================================================--
app.get("/api/getkey", (req, res) => {
    const { hwid } = req.query;
    if (!hwid) return res.json({ ok: false, msg: "No HWID" });

    const existing = db.prepare("SELECT * FROM keys WHERE hwid = ? AND status = 'active'").get(hwid);
    if (existing) {
        return res.json({ ok: true, key: existing.key, msg: "Key kamu sudah ada" });
    }

    let newKey;
    let attempts = 0;
    while (attempts < 10) {
        newKey = generateKey();
        const dup = db.prepare("SELECT id FROM keys WHERE key = ?").get(newKey);
        if (!dup) break;
        attempts++;
    }

    const expiresAt = Math.floor(Date.now() / 1000) + (24 * 60 * 60);
    db.prepare("INSERT INTO keys (key, hwid, expires_at) VALUES (?, ?, ?)")
      .run(newKey, hwid, expiresAt);

    return res.json({ ok: true, key: newKey, msg: "Key dibuat! Berlaku 24 jam" });
});

//========================================================--
// ADMIN ENDPOINTS
//========================================================--
app.get("/api/admin/keys", authAdmin, (req, res) => {
    const keys = db.prepare("SELECT * FROM keys ORDER BY created_at DESC LIMIT 200").all();
    res.json({ ok: true, keys });
});

app.post("/api/admin/create", authAdmin, (req, res) => {
    const { duration_hours } = req.body;
    let newKey, attempts = 0;
    while (attempts < 10) {
        newKey = generateKey();
        const dup = db.prepare("SELECT id FROM keys WHERE key = ?").get(newKey);
        if (!dup) break;
        attempts++;
    }
    const expiresAt = duration_hours
        ? Math.floor(Date.now() / 1000) + (duration_hours * 3600)
        : null;
    db.prepare("INSERT INTO keys (key, expires_at) VALUES (?, ?)").run(newKey, expiresAt);
    res.json({ ok: true, key: newKey });
});

app.delete("/api/admin/delete/:id", authAdmin, (req, res) => {
    db.prepare("DELETE FROM keys WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
});

app.post("/api/admin/reset/:id", authAdmin, (req, res) => {
    db.prepare("UPDATE keys SET hwid = NULL WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
});

//========================================================--
// START
//========================================================--
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Mawww Key System running on port ${PORT}`);
    console.log(`📁 Database: ${DB_PATH}`);
});
