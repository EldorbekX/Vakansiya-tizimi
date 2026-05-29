const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Frontend fayllarini serve qilish
app.use(express.static(path.join(__dirname, '../frontend')));

const DB_FILE = path.join(__dirname, 'db.json');

// ─── Ma'lumotlar bazasi (JSON fayl) ───────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const empty = { applications: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(empty, null, 2));
    return empty;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function getMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}

const MAX_LIMIT = 5;

// ─── PATCH 1: Rate Limiting ────────────────────────────────────
// Har bir IP uchun: 1 daqiqada max 20 so'rov
const rateLimitMap = new Map(); // ip -> { count, resetAt }

function rateLimit(maxRequests = 20, windowMs = 60_000) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const now = Date.now();
    const entry = rateLimitMap.get(ip);

    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count++;
    if (entry.count > maxRequests) {
      return res.status(429).json({
        ok: false,
        message: "Juda ko'p so'rov. 1 daqiqa kuting."
      });
    }
    next();
  };
}

// Barcha API endpointlarga rate limit
app.use('/api/', rateLimit(20, 60_000));

// ─── PATCH 2: Admin Lockout ────────────────────────────────────
// Har bir IP uchun: 5 marta xato bo'lsa 15 daqiqa blok
const adminFailMap = new Map(); // ip -> { fails, blockedUntil }

function adminBruteGuard(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const now = Date.now();
  const entry = adminFailMap.get(ip) || { fails: 0, blockedUntil: 0 };

  if (now < entry.blockedUntil) {
    const minsLeft = Math.ceil((entry.blockedUntil - now) / 60_000);
    return res.status(429).json({
      ok: false,
      message: `Bloklangan. ${minsLeft} daqiqadan so'ng urinib ko'ring.`
    });
  }

  req._adminIp = ip;
  req._adminEntry = entry;
  next();
}

// DEV ONLY — test uchun, production da o'chiring!
app.post('/api/dev/reset-blocks', (req, res) => {
  rateLimitMap.clear();
  adminFailMap.clear();
  res.json({ ok: true, message: 'Barcha bloklar tozalandi' });
});

function adminFailRecord(req) {
  const entry = req._adminEntry;
  entry.fails++;
  if (entry.fails >= 5) {
    entry.blockedUntil = Date.now() + 15 * 60_000; // 15 daqiqa
    entry.fails = 0;
  }
  adminFailMap.set(req._adminIp, entry);
}

function adminSuccessRecord(req) {
  adminFailMap.set(req._adminIp, { fails: 0, blockedUntil: 0 });
}

// ─── API: Ariza topshirish ─────────────────────────────────────
app.post('/api/apply', (req, res) => {
  const { jshshir, vacancy_id, fio, phone } = req.body;

  if (!jshshir || !vacancy_id || !fio || !phone) {
    return res.status(400).json({
      ok: false,
      message: "Barcha maydonlar to'ldirilishi shart"
    });
  }

  if (!/^\d{14}$/.test(jshshir)) {
    return res.status(400).json({
      ok: false,
      message: "JSHSHIR 14 ta raqamdan iborat bo'lishi kerak"
    });
  }

  const month = getMonth();
  const db = loadDB();

  const myApps = db.applications.filter(
    a => a.jshshir === jshshir && a.month === month
  );

  if (myApps.find(a => a.vacancy_id === vacancy_id)) {
    return res.status(400).json({
      ok: false,
      message: "Bu vakansiyaga allaqachon ariza topshirgansiz!"
    });
  }

  if (myApps.length >= MAX_LIMIT) {
    return res.status(400).json({
      ok: false,
      message: `Oylik limit tugadi! Bu oy ${myApps.length}/${MAX_LIMIT} ta ariza topshirgansiz.`
    });
  }

  db.applications.push({
    id: Date.now(),
    jshshir,
    vacancy_id,
    fio,
    phone,
    month,
    status: 'pending',
    applied_at: new Date().toISOString()
  });
  saveDB(db);

  return res.json({
    ok: true,
    message: "Ariza muvaffaqiyatli qabul qilindi!",
    used: myApps.length + 1,
    remaining: MAX_LIMIT - (myApps.length + 1)
  });
});

// ─── API: JSHSHIR bo'yicha holat ──────────────────────────────
// PATCH 3: Enumeration himoyasi — faqat ariza topshirilgan bo'lsa ma'lumot beradi
app.get('/api/status/:jshshir', (req, res) => {
  const { jshshir } = req.params;

  if (!/^\d{14}$/.test(jshshir)) {
    return res.status(400).json({
      ok: false,
      message: "JSHSHIR noto'g'ri"
    });
  }

  const month = getMonth();
  const db = loadDB();

  const myApps = db.applications.filter(
    a => a.jshshir === jshshir && a.month === month
  );

  // Agar hech qanday ariza yo'q bo'lsa — neytral javob (ma'lumot sizib chiqmaydi)
  if (myApps.length === 0) {
    return res.json({
      ok: true,
      used: 0,
      remaining: MAX_LIMIT,
      vacancy_ids: [],
      applications: []
    });
  }

  return res.json({
    ok: true,
    used: myApps.length,
    remaining: Math.max(0, MAX_LIMIT - myApps.length),
    vacancy_ids: myApps.map(a => a.vacancy_id),
    applications: myApps.map(a => ({
      vacancy_id: a.vacancy_id,
      applied_at: a.applied_at,
      status: a.status
    }))
  });
});

// ─── API: Admin — barcha arizalar (himoyalangan) ──────────────
app.get('/api/admin/applications', adminBruteGuard, (req, res) => {
  const adminKey = req.headers['x-admin-key'];

  if (adminKey !== process.env.ADMIN_KEY) {
    adminFailRecord(req);
    return res.status(403).json({ ok: false, message: "Ruxsat yo'q" });
  }

  adminSuccessRecord(req);
  const db = loadDB();
  return res.json({ ok: true, data: db.applications });
});

// ─── Barcha boshqa so'rovlarni frontend ga yuborish ───────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server ishga tushdi: http://localhost:${PORT}`);
});