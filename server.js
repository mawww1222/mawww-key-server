//========================================================--
// MAWWWHUB KEY SYSTEM — Backend (Fixed & Hardened)
//========================================================--
const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

//========================================================--
// DATABASE SETUP (with error guard)
//========================================================--
const DB_PATH = process.env.DB_PATH || "./data/database.db";
const dbDir = path.dirname(DB_PATH);

try {
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
} catch (e) {
    console.error("❌ Gagal buat folder database:", e.message);
}

let db;
try {
    db = new Database(DB_PATH);
    console.log("✅ Database connected:", DB_PATH);
} catch (e) {
    console.error("❌ Gagal connect database:", e.message);
    process.exit(1);
}

//========================================================--
// MIDDLEWARE
//========================================================--
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

//========================================================--
// DATABASE SCHEMA
//========================================================--
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
    CREATE INDEX IF NOT EXISTS idx_key ON keys(key);
    CREATE INDEX IF NOT EXISTS idx_status ON keys(status);
`);

//========================================================--
// CONFIG
//========================================================--
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const DISCORD_LINK = process.env.DISCORD_LINK || "https://discord.gg/yourlink";
const OWNER_WA = process.env.OWNER_WA || "6295618962380";

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
// ROUTES — PUBLIC
//========================================================--
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/api/info", (req, res) => {
    res.json({
        ok: true,
        service: "MawwwHub",
        discord: DISCORD_LINK,
        wa: OWNER_WA,
        version: "1.0.0"
    });
});

app.get("/health", (req, res) => {
    res.json({ ok: true, time: Date.now(), uptime: process.uptime() });
});

//========================================================--
// VALIDATE KEY (untuk Roblox)
//========================================================--
app.get("/api/validate", (req, res) => {
    try {
        const { key, hwid } = req.query;

        if (!key) return res.json({ ok: false, msg: "Key tidak boleh kosong" });
        if (!hwid) return res.json({ ok: false, msg: "HWID tidak terdeteksi" });

        const cleanKey = String(key).trim().toUpperCase();
        const entry = db.prepare("SELECT * FROM keys WHERE key = ?").get(cleanKey);

        if (!entry) {
            return res.json({ ok: false, msg: "Key tidak terdaftar" });
        }

        if (entry.status !== "active") {
            return res.json({ ok: false, msg: "Key sudah tidak aktif" });
        }

        if (entry.expires_at && entry.expires_at < Math.floor(Date.now() / 1000)) {
            return res.json({ ok: false, msg: "Key sudah expired" });
        }

        // Bind HWID kalau belum
        if (!entry.hwid) {
            db.prepare("UPDATE keys SET hwid = ?, used_count = used_count + 1 WHERE id = ?")
              .run(hwid, entry.id);
            return res.json({
                ok: true,
                msg: "Key berhasil diaktifkan",
                type: entry.duration_type,
                expires_at: entry.expires_at
            });
        }

        // Cek HWID cocok
        if (entry.hwid !== hwid) {
            return res.json({ ok: false, msg: "Key sudah dipakai di device lain" });
        }

        db.prepare("UPDATE keys SET used_count = used_count + 1 WHERE id = ?").run(entry.id);

        return res.json({
            ok: true,
            msg: "Key valid",
            type: entry.duration_type,
            expires_at: entry.expires_at
        });
    } catch (e) {
        console.error("Validate error:", e.message);
        return res.status(500).json({ ok: false, msg: "Server error" });
    }
});

//========================================================--
// ADMIN: LOGIN
//========================================================--
app.post("/api/admin/login", (req, res) => {
    try {
        const { password } = req.body;
        if (password === ADMIN_PASSWORD) {
            return res.json({ ok: true });
        }
        return res.json({ ok: false, msg: "Password salah" });
    } catch (e) {
        return res.status(500).json({ ok: false, msg: "Server error" });
    }
});

//========================================================--
// ADMIN: GENERATE KEY
//========================================================--
app.post("/api/admin/generate", authAdmin, (req, res) => {
    try {
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
            ).run(
                newKey,
                duration_type || "permanent",
                parseInt(duration_days) || 0,
                expiresAt,
                note || ""
            );

            created.push(newKey);
        }

        res.json({ ok: true, keys: created, count: created.length });
    } catch (e) {
        console.error("Generate error:", e.message);
        res.status(500).json({ ok: false, msg: "Gagal generate key" });
    }
});

//========================================================--
// ADMIN: LIST KEYS
//========================================================--
app.get("/api/admin/keys", authAdmin, (req, res) => {
    try {
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

        if (conditions.length) {
            query += " WHERE " + conditions.join(" AND ");
        }

        query += " ORDER BY created_at DESC LIMIT 500";

        const keys = db.prepare(query).all(...params);

        const stats = {
            total: db.prepare("SELECT COUNT(*) as c FROM keys").get().c,
            active: db.prepare("SELECT COUNT(*) as c FROM keys WHERE status = 'active'").get().c,
            bound: db.prepare("SELECT COUNT(*) as c FROM keys WHERE hwid IS NOT NULL").get().c,
            permanent: db.prepare("SELECT COUNT(*) as c FROM keys WHERE duration_type = 'permanent'").get().c,
        };

        res.json({ ok: true, keys, stats });
    } catch (e) {
        console.error("List keys error:", e.message);
        res.status(500).json({ ok: false, msg: "Server error" });
    }
});

//========================================================--
// ADMIN: DELETE KEY
//========================================================--
app.delete("/api/admin/delete/:id", authAdmin, (req, res) => {
    try {
        db.prepare("DELETE FROM keys WHERE id = ?").run(req.params.id);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, msg: "Gagal hapus key" });
    }
});

//========================================================--
// ADMIN: RESET HWID
//========================================================--
app.post("/api/admin/reset/:id", authAdmin, (req, res) => {
    try {
        db.prepare("UPDATE keys SET hwid = NULL WHERE id = ?").run(req.params.id);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, msg: "Gagal reset HWID" });
    }
});

//========================================================--
// ADMIN: TOGGLE STATUS
//========================================================--
app.post("/api/admin/toggle/:id", authAdmin, (req, res) => {
    try {
        const entry = db.prepare("SELECT * FROM keys WHERE id = ?").get(req.params.id);
        if (!entry) return res.json({ ok: false, msg: "Key tidak ditemukan" });

        const newStatus = entry.status === "active" ? "disabled" : "active";
        db.prepare("UPDATE keys SET status = ? WHERE id = ?").run(newStatus, req.params.id);

        res.json({ ok: true, status: newStatus });
    } catch (e) {
        res.status(500).json({ ok: false, msg: "Gagal toggle status" });
    }
});

//========================================================--
// ADMIN: EXTEND KEY
//========================================================--
app.post("/api/admin/extend/:id", authAdmin, (req, res) => {
    try {
        const { days } = req.body;
        const entry = db.prepare("SELECT * FROM keys WHERE id = ?").get(req.params.id);
        if (!entry) return res.json({ ok: false, msg: "Key tidak ditemukan" });

        const addSecs = (parseInt(days) || 0) * 24 * 60 * 60;
        const now = Math.floor(Date.now() / 1000);
        const base = entry.expires_at && entry.expires_at > now ? entry.expires_at : now;
        const newExpiry = base + addSecs;

        db.prepare("UPDATE keys SET expires_at = ?, duration_type = 'days' WHERE id = ?")
          .run(newExpiry, req.params.id);

        res.json({ ok: true, expires_at: newExpiry });
    } catch (e) {
        res.status(500).json({ ok: false, msg: "Gagal extend key" });
    }
});

//========================================================--
// 404 FALLBACK
//========================================================--
app.use((req, res) => {
    res.status(404).json({ ok: false, msg: "404 - Not Found" });
});

//========================================================--
// START SERVER
//========================================================--
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n╔════════════════════════════════════════╗`);
    console.log(`║  ☂️  MawwwHub Key System               ║`);
    console.log(`╚════════════════════════════════════════╝`);
    console.log(`🚀 Running on port ${PORT}`);
    console.log(`📁 Database: ${DB_PATH}`);
    console.log(`🌐 Admin: /admin`);
    console.log(`❤️  Health: /health\n`);
});
