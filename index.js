const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cheerio = require('cheerio');
const { chromium } = require('playwright-core');
const crypto = require('crypto');
const { ProxyAgent, fetch: undiciFetch } = require('undici');

// ── РФ-ПРОКСИ ──────────────────────────────────────────────────────────────
// WB и Ozon блокируют по геолокации IP (не по антибот-фингерпринту), поэтому
// Playwright/Firecrawl с обычных дата-центровых IP не решают задачу быстро —
// они просто дольше пытаются достучаться до заблокированного ресурса.
// Решение: РФ-прокси. Задаётся в Railway Variables как RU_PROXY_URL, формат:
//   http://user:pass@host:port  (датацентровый РФ-IP, резидентский не нужен)
// Без переменной ruFetch() ведёт себя как обычный fetch — ничего не ломается.
const RU_PROXY_URL = process.env.RU_PROXY_URL || null;
const ruProxyAgent = RU_PROXY_URL ? new ProxyAgent(RU_PROXY_URL) : null;
if (ruProxyAgent) console.log('[ru-proxy] включён, будет использоваться для wildberries.ru и ozon.ru');
else console.log('[ru-proxy] RU_PROXY_URL не задан — WB/Ozon идут напрямую (геоблок ожидаем)');

async function ruFetch(url, opts = {}) {
  if (ruProxyAgent) {
    return undiciFetch(url, { ...opts, dispatcher: ruProxyAgent });
  }
  return fetch(url, opts);
}

// Ozon отдаёт 307-редирект с Set-Cookie как антибот-проверку (видно по
// прямому curl через прокси). Обычный fetch с redirect:'follow' не хранит
// cookie между шагами редиректа — каждый следующий запрос снова выглядит
// "новым" для антибота, он редиректит опять, и так до "redirect count
// exceeded". Реальный браузер (Playwright) хранит cookie автоматически —
// поэтому там работает, а у голого fetch нет. Разруливаем вручную.
async function fetchWithCookies(url, opts = {}, maxRedirects = 10) {
  let currentUrl = url;
  let cookieJar = '';
  for (let i = 0; i <= maxRedirects; i++) {
    const headers = { ...(opts.headers || {}) };
    if (cookieJar) headers['Cookie'] = cookieJar;
    const resp = await ruFetch(currentUrl, { ...opts, headers, redirect: 'manual' });

    // Копим cookie из этого ответа
    const setCookie = typeof resp.headers.getSetCookie === 'function'
      ? resp.headers.getSetCookie()
      : (resp.headers.get('set-cookie') ? [resp.headers.get('set-cookie')] : []);
    if (setCookie && setCookie.length) {
      const newPairs = setCookie.map(c => c.split(';')[0]).join('; ');
      cookieJar = cookieJar ? `${cookieJar}; ${newPairs}` : newPairs;
    }

    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get('location');
      if (!loc) return resp;
      currentUrl = new URL(loc, currentUrl).toString();
      continue;
    }
    return resp;
  }
  throw new Error('redirect count exceeded (fetchWithCookies)');
}

const app = express();
const PORT = process.env.PORT || 3000;
// JWT_SECRET берётся только из Railway Variables. Без него — случайный секрет на время жизни
// процесса (безопасно, но токены сбрасываются при каждом рестарте), хардкода в коде больше нет.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('[security] JWT_SECRET не задан в Railway Variables — используется временный случайный секрет, сессии будут сбрасываться при рестарте. Задай JWT_SECRET.');
}

// ── БУФЕР ЛОГОВ ───────────────────────────────────────────────────────────────
const LOG_BUFFER_SIZE = 500;
const logBuffer = [];
const _origLog = console.log.bind(console);
const _origError = console.error.bind(console);
function pushLog(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`;
  logBuffer.push(line);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
}
console.log = (...args) => { _origLog(...args); pushLog('LOG', args); };
console.error = (...args) => { _origError(...args); pushLog('ERR', args); };

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS wishlist (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      shop TEXT,
      url TEXT,
      price TEXT,
      size TEXT,
      image TEXT,
      added_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS parse_status TEXT;
    ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS parse_attempts INTEGER DEFAULT 0;
    ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS received_at TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS add_key TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tg_chat_id BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tg_link_code TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS users_tg_chat_idx ON users(tg_chat_id);
    CREATE UNIQUE INDEX IF NOT EXISTS users_add_key_idx ON users(add_key);
    CREATE TABLE IF NOT EXISTS tg_media (
      id         SERIAL PRIMARY KEY,
      token      VARCHAR(40) UNIQUE NOT NULL,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      mime       TEXT NOT NULL,
      data       BYTEA NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sizes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Миграция: добавляем недостающие колонки, если таблица wishlist создавалась раньше без них
  await pool.query(`
    ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS added_at TIMESTAMP DEFAULT NOW();
    ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS shop TEXT;
    ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS url TEXT;
    ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS price TEXT;
    ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS size TEXT;
    ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS image TEXT;
  `);
  // Миграция: уникальный индекс на sizes.user_id (нужен для ON CONFLICT в POST /sizes)
  // Миграция sizes (роадмап 1.1): реальная таблица в проде могла быть создана по старой схеме
  // (напр. колонка category TEXT NOT NULL без DEFAULT), а CREATE TABLE IF NOT EXISTS её не меняет.
  // Все шаги идемпотентны и неразрушающие; ошибка миграции не должна валить старт приложения.
  try {
    await pool.query(`ALTER TABLE sizes ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}'`);
    await pool.query(`ALTER TABLE sizes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);
    // Любая «лишняя» NOT NULL колонка без DEFAULT (category и т.п.) ломает INSERT из кода — снимаем NOT NULL.
    const strict = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'sizes'
        AND is_nullable = 'NO' AND column_default IS NULL
        AND column_name NOT IN ('id', 'user_id', 'data')
    `);
    for (const row of strict.rows) {
      await pool.query(`ALTER TABLE sizes ALTER COLUMN "${row.column_name}" DROP NOT NULL`);
      console.log(`[migrate] sizes.${row.column_name}: снят NOT NULL`);
    }
    // POST /sizes использует ON CONFLICT (user_id) — нужна ровно одна строка на пользователя.
    // Если в старой схеме было несколько строк на user_id: бэкап-копия таблицы, затем слияние data.
    const dups = await pool.query(`SELECT user_id FROM sizes GROUP BY user_id HAVING COUNT(*) > 1`);
    if (dups.rows.length) {
      await pool.query(`CREATE TABLE IF NOT EXISTS sizes_backup_pre_merge AS SELECT * FROM sizes`);
      for (const { user_id } of dups.rows) {
        const rows = await pool.query(`SELECT id, data FROM sizes WHERE user_id=$1 ORDER BY id ASC`, [user_id]);
        const merged = rows.rows.reduce((acc, r) => ({ ...acc, ...(r.data || {}) }), {});
        const keepId = rows.rows[rows.rows.length - 1].id;
        await pool.query(`UPDATE sizes SET data=$1::jsonb WHERE id=$2`, [JSON.stringify(merged), keepId]);
        await pool.query(`DELETE FROM sizes WHERE user_id=$1 AND id<>$2`, [user_id, keepId]);
      }
      console.log(`[migrate] sizes: объединены дубли строк у ${dups.rows.length} пользователей (бэкап: sizes_backup_pre_merge)`);
    }
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'sizes_user_id_unique'
        ) THEN
          ALTER TABLE sizes ADD CONSTRAINT sizes_user_id_unique UNIQUE (user_id);
        END IF;
      END $$;
    `);
    console.log('[migrate] sizes OK');
  } catch (e) {
    console.error('[migrate] sizes: ОШИБКА миграции —', e.message);
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS share_links (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      VARCHAR(64) UNIQUE NOT NULL,
      sections   JSONB NOT NULL DEFAULT '{}',
      expires_at TIMESTAMP NULL,
      revoked_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_share_links_token ON share_links(token);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      zone       TEXT NOT NULL,
      name       TEXT NOT NULL,
      brand      TEXT,
      size       TEXT,
      note       TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_items_user_zone ON items(user_id, zone);
  `);
  // Вещи v2: ссылка/фото/магазин, посадка (small|true|large), откуда добавлена, связь с вишлистом
  await pool.query(`
    ALTER TABLE items ADD COLUMN IF NOT EXISTS url TEXT;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS image TEXT;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS shop TEXT;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS fit TEXT;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS source TEXT;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS wishlist_id INTEGER;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
    ALTER TABLE items ADD COLUMN IF NOT EXISTS my_photo TEXT;
  `);

  await pool.query("UPDATE wishlist SET parse_status='failed' WHERE parse_status='pending'");

  const usersCountRes = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  const usersCount = usersCountRes.rows[0].c;
  console.log(`[seed] users count at startup: ${usersCount}`);

  const adminCheck = await pool.query("SELECT id FROM users WHERE username='admin'");
  const adminPassEnv = process.env.ADMIN_PASSWORD || null;

  if (adminCheck.rows.length) {
    const adminId = adminCheck.rows[0].id;
    if (adminPassEnv) {
      const hash = await bcrypt.hash(adminPassEnv, 10);
      await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, adminId]);
      console.log(`[seed] admin id=${adminId}: пароль синхронизирован с ADMIN_PASSWORD`);
    } else {
      console.log(`[seed] admin id=${adminId} уже существует, пароль не трогаем (задай ADMIN_PASSWORD в Railway Variables, чтобы сменить)`);
    }
  } else {
    // Без ADMIN_PASSWORD создаём admin со случайным паролем — войти нельзя, пока не задана переменная.
    // id не указываем явно: на пустой таблице SERIAL даст id=1 (совпадает с legacy user_id=1).
    const hash = await bcrypt.hash(adminPassEnv || crypto.randomBytes(24).toString('hex'), 10);
    const r = await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES ('admin','admin@sizebook.local',$1) RETURNING id",
      [hash]
    );
    console.log(`[seed] создан admin id=${r.rows[0].id}` + (adminPassEnv ? '' : ' со случайным паролем (задай ADMIN_PASSWORD)'));
    if (usersCount > 0) {
      console.log(`[seed] WARNING: users не была пустой (count=${usersCount}); id admin может не совпасть с legacy user_id=1.`);
    }
  }
  console.log('DB ready');
}

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Гостевой режим (user_id=1) — только по явному флагу ALLOW_GUEST_MODE=1, по умолчанию выключен.
const ALLOW_GUEST_MODE = process.env.ALLOW_GUEST_MODE === '1';

function authenticateToken(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) {
    if (ALLOW_GUEST_MODE) { req.user = { id: 1 }; return next(); }
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      if (ALLOW_GUEST_MODE) { req.user = { id: 1 }; return next(); }
      return res.status(401).json({ error: 'Недействительный токен' });
    }
    req.user = user;
    next();
  });
}

// /parse не привязан к пользователю (только разбор ссылки) и вызывается из CI без токена —
// оставляем прежнее поведение (открыт), токен если есть — проверяем мягко.
function optionalAuth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) { req.user = { id: 1 }; return next(); }
  jwt.verify(token, JWT_SECRET, (err, user) => { req.user = err ? { id: 1 } : user; next(); });
}

// /debug/* — только при ENABLE_DEBUG=1 в Railway Variables (по умолчанию выключено: эндпоинты открыты и жгут кредиты Firecrawl)
app.use('/debug', (req, res, next) => process.env.ENABLE_DEBUG === '1' ? next() : res.status(404).json({ error: 'Not found' }));

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Заполни все поля' });
  try {
    const countRes = await pool.query('SELECT COUNT(*)::int AS c FROM users');
    if (countRes.rows[0].c >= 10) {
      return res.status(403).json({ error: 'Достигнут лимит регистраций (10 аккаунтов)' });
    }
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO users (username,email,password_hash) VALUES ($1,$2,$3) RETURNING id,username,email',
      [username.toLowerCase(), email.toLowerCase(), hash]
    );
    const user = r.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Пользователь уже существует' });
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Заполни все поля' });
  try {
    const r = await pool.query(
      'SELECT * FROM users WHERE email=$1 OR username=$1',
      [email.toLowerCase()]
    );
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Неверный пароль' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────
app.get('/admin/logs', (req, res) => {
  const LOGS_SECRET = process.env.LOGS_SECRET;
  const validSecret = LOGS_SECRET && req.query.secret === LOGS_SECRET;
  if (!validSecret) {
    // Fallback: JWT admin
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (!token) return res.status(403).json({ error: 'Forbidden' });
    try {
      const user = jwt.verify(token, JWT_SECRET);
      if (user?.username !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    } catch { return res.status(403).json({ error: 'Forbidden' }); }
  }
  const n = Math.min(parseInt(req.query.n) || 200, LOG_BUFFER_SIZE);
  const filter = req.query.filter || '';
  let lines = logBuffer.slice(-n);
  if (filter) lines = lines.filter(l => l.includes(filter));
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(lines.join('\n') + '\n');
});

// ── SIZES ─────────────────────────────────────────────────────────────────────
app.get('/sizes', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM sizes WHERE user_id=$1', [req.user.id]);
    res.json(r.rows[0]?.data || {});
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

app.post('/sizes', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO sizes (user_id, data) VALUES ($1,$2::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET data = sizes.data || $2::jsonb, updated_at=NOW()`,
      [req.user.id, JSON.stringify(req.body)]
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

// ── WISHLIST ──────────────────────────────────────────────────────────────────
app.get('/wishlist', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM wishlist WHERE user_id=$1 ORDER BY id DESC',
      [req.user.id]
    );
    res.json(r.rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

app.post('/wishlist', authenticateToken, async (req, res) => {
  const { title, shop, url, price, size, image, autotitle } = req.body;
  if (!title) return res.status(400).json({ error: 'Нужно название' });
  let valid = false;
  try { valid = !!url && /^https?:$/.test(new URL(url).protocol); } catch (_) {}
  const needsEnrich = valid && (autotitle || !price || !image);
  try {
    const r = await pool.query(
      'INSERT INTO wishlist (user_id,title,shop,url,price,size,image,parse_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [req.user.id, title, shop||null, url||null, price||null, size||null, image||null, needsEnrich ? 'pending' : null]
    );
    res.json(r.rows[0]);
    if (needsEnrich) enrichWishlistItem(r.rows[0].id, req.user.id, url, autotitle ? title : null);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

// ── БЫСТРОЕ ДОБАВЛЕНИЕ ИЗ «ПОДЕЛИТЬСЯ» (iOS Команды / Android) ───────────────
// Личный ключ добавления: даёт право ТОЛЬКО добавлять товары в свой вишлист (не логин).
app.get('/me/add-key', authenticateToken, async (req, res) => {
  try {
    let r = await pool.query('SELECT add_key FROM users WHERE id=$1', [req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Не найден' });
    let key = r.rows[0].add_key;
    if (!key) {
      key = crypto.randomBytes(18).toString('hex');
      await pool.query('UPDATE users SET add_key=$1 WHERE id=$2', [key, req.user.id]);
    }
    res.json({ key });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/me/add-key/rotate', authenticateToken, async (req, res) => {
  try {
    const key = crypto.randomBytes(18).toString('hex');
    await pool.query('UPDATE users SET add_key=$1 WHERE id=$2', [key, req.user.id]);
    res.json({ key });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка' }); }
});

// Общая функция: достаёт первую ссылку из текста, кладёт товар в вишлист (pending), возвращает функцию фонового дополнения.
async function addWishlistFromText(userId, raw) {
  const m = String(raw).match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return { error: 'Ссылка не найдена' };
  return addWishlistUrl(userId, m[0].replace(/[).,;]+$/, ''));
}
async function addWishlistUrl(userId, url) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return { error: 'Некорректная ссылка' }; }
  const dup = await pool.query('SELECT id FROM wishlist WHERE user_id=$1 AND url=$2 LIMIT 1', [userId, url]);
  if (dup.rows[0]) return { duplicate: true, host, id: dup.rows[0].id };
  const r = await pool.query(
    "INSERT INTO wishlist (user_id,title,shop,url,parse_status) VALUES ($1,$2,$3,$4,'pending') RETURNING id",
    [userId, host, host, url]
  );
  return { host, url, id: r.rows[0].id, enrich: () => enrichWishlistItem(r.rows[0].id, userId, url, host) };
}

// ── Посты из Telegram-каналов-магазинов ──────────────────────────────────────
// Ссылка в посте обычно спрятана: под словом (entity text_link) или в кнопке под постом.
// Если ссылки на магазин нет вовсе («пишите в директ»), сохраняем вещь из самого поста:
// название и цена из текста, фото (или обложка видео) — из вложения.
const TG_SKIP_LINK_RE = /(^|\.)(t\.me|telegram\.me|telegram\.org|telegram\.dog|wa\.me|whatsapp\.com|instagram\.com|youtube\.com|youtu\.be|tiktok\.com)$/i;
function tgCollectLinks(msgs) {
  const inText = [], inButtons = [];
  for (const msg of msgs) {
    const text = String(msg.text || msg.caption || '');
    const ents = msg.entities || msg.caption_entities || [];
    for (const e of ents) {
      if (e.type === 'text_link' && e.url) inText.push(e.url);
      else if (e.type === 'url') inText.push(text.substr(e.offset, e.length));
    }
    for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) inText.push(m[0]);
    for (const row of (msg.reply_markup && msg.reply_markup.inline_keyboard) || [])
      for (const b of row) if (b.url) inButtons.push(b.url);
  }
  const seen = new Set(), out = [];
  for (let raw of [...inText, ...inButtons]) {
    raw = String(raw).trim().replace(/[).,;!»]+$/, '');
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    let u; try { u = new URL(raw); } catch (_) { continue; }
    if (TG_SKIP_LINK_RE.test(u.hostname)) continue;
    if (seen.has(u.href)) continue;
    seen.add(u.href); out.push(u.href);
  }
  // Ссылка на конкретную страницу важнее ссылки на главную магазина
  return out.sort((a, b) => (new URL(a).pathname.length > 1 ? 0 : 1) - (new URL(b).pathname.length > 1 ? 0 : 1));
}

function tgPostInfo(msgs) {
  const text = msgs.map(m => m.text || m.caption || '').filter(Boolean).join('\n').trim();
  const fwd = msgs.find(m => m.forward_origin || m.forward_from_chat) || msgs[0];
  const origin = fwd.forward_origin || {};
  const chat = origin.chat || fwd.forward_from_chat || null;
  const postId = origin.message_id || fwd.forward_from_message_id;
  const channel = chat ? (chat.title || chat.username || null) : null;
  const postUrl = chat && chat.username && postId ? `https://t.me/${chat.username}/${postId}` : null;

  // Название: первая содержательная строка без эмодзи, хэштегов, ссылок и цены
  let title = null;
  for (let line of text.split('\n')) {
    line = line.replace(/https?:\/\/\S+/g, '').replace(/#[\p{L}\p{N}_]+/gu, '')
      .replace(/[\p{Extended_Pictographic}️‍]/gu, '').replace(/^[\s\-–—•*·|:>]+/, '').trim();
    if (!/\p{L}{3,}/u.test(line)) continue;
    if (/^(цена|стоимость|price|размер|sizes?|артикул|в наличии|заказ|доставка)\b/i.test(line)) continue;
    title = line.length > 120 ? line.slice(0, 117).trim() + '…' : line;
    break;
  }

  // Цена: «12 990 ₽», «5990 руб», «Цена: 4 500»
  let price = null;
  const cur = text.match(/(\d{1,3}(?:[  .,]\d{3})+|\d{3,7})\s?(₽|руб\.?|р\.|rub\b|byn\b|₸|\$|€|usd\b|eur\b)/i)
    || text.match(/(?:цена|стоимость|price)\D{0,15}(\d{1,3}(?:[  .]\d{3})+|\d{3,7})/i);
  if (cur) {
    const num = cur[1].replace(/[  .,]/g, '');
    const c = (cur[2] || '₽').toLowerCase();
    const sym = /^(₽|руб|р\.|rub)/.test(c) ? '₽' : /byn/.test(c) ? 'BYN' : /usd|\$/.test(c) ? '$' : /eur|€/.test(c) ? '€' : c;
    price = `${Number(num).toLocaleString('ru-RU').replace(/ /g, ' ')} ${sym}`;
  }

  // Картинка: фото → обложка видео → превью видео/гифки/файла
  let media = null;
  for (const m of msgs) {
    if (m.photo && m.photo.length) { media = m.photo[m.photo.length - 1]; break; }
  }
  if (!media) for (const m of msgs) {
    const v = m.video || m.animation || m.document;
    if (!v) continue;
    if (v.cover && v.cover.length) { media = v.cover[v.cover.length - 1]; break; }
    if (v.thumbnail || v.thumb) { media = v.thumbnail || v.thumb; break; }
  }
  return { text, title, price, channel, postUrl, media, fileId: media ? media.file_id : null };
}

const PUBLIC_BASE = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '');
// Скачиваем файл из Telegram и храним у себя: прямые ссылки Telegram содержат токен бота и живут ~1 час
async function tgSaveMedia(userId, fileId) {
  try {
    const f = await tgApi('getFile', { file_id: fileId });
    if (!f || !f.ok || !f.result.file_path) return null;
    const r = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${f.result.file_path}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 8 * 1024 * 1024) return null;
    const ext = (f.result.file_path.split('.').pop() || '').toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const token = crypto.randomBytes(16).toString('hex');
    await pool.query('INSERT INTO tg_media (token, user_id, mime, data) VALUES ($1,$2,$3,$4)', [token, userId, mime, buf]);
    return `${PUBLIC_BASE}/media/${token}`;
  } catch (e) { console.log('[tg] media error', e.message); return null; }
}

// Обработка одного поста (или альбома — несколько сообщений с одним media_group_id)
async function tgHandlePost(chatId, userId, msgs) {
  const links = tgCollectLinks(msgs);
  const info = tgPostInfo(msgs);

  if (links.length) {
    const out = await addWishlistUrl(userId, links[0]);
    if (out.error) return tgSend(chatId, 'Не получилось разобрать ссылку из поста.');
    if (out.duplicate) return tgSend(chatId, `Эта вещь уже в вишлисте (${out.host}).`, tgOwnKeyboard(out.id));
    await tgSend(chatId, `Добавил: ${out.host}. Подтягиваю название и цену…`);
    let e = await out.enrich();
    // Чего не отдал магазин — берём из поста
    const fill = {};
    if (info.title && (!e || !e.title || e.title === out.host)) fill.title = info.title;
    if (info.price && (!e || !e.price)) fill.price = info.price;
    if (info.fileId && (!e || !e.image)) fill.image = await tgSaveMedia(userId, info.fileId);
    if (fill.title || fill.price || fill.image) {
      await pool.query(
        `UPDATE wishlist SET title=COALESCE($1,title), price=COALESCE(NULLIF(price,''),$2), image=COALESCE(NULLIF(image,''),$3),
           parse_status='done' WHERE id=$4 AND user_id=$5`,
        [fill.title || null, fill.price || null, fill.image || null, out.id, userId]);
      e = { title: fill.title || (e && e.title) || out.host, price: (e && e.price) || fill.price || null,
            image: (e && e.image) || fill.image || null, found: true };
    }
    if (e && e.found) return tgSendItem(chatId, fill.image ? { ...e, image: info.fileId } : e, out.id);
    return tgSend(chatId, 'Вещь сохранена. Магазин пока не отдал название и цену — попробую ещё раз в ближайшие минуты и напишу сюда.', tgOwnKeyboard(out.id));
  }

  // Ссылки на магазин нет — сохраняем по самому посту
  if (!info.title && !info.fileId) {
    return tgSend(chatId, 'Не нашёл в сообщении ни ссылки на товар, ни описания. Перешлите сюда пост целиком или пришлите ссылку через «Поделиться» в приложении магазина.');
  }
  if (info.postUrl) {
    const dup = await pool.query('SELECT id FROM wishlist WHERE user_id=$1 AND url=$2 LIMIT 1', [userId, info.postUrl]);
    if (dup.rows[0]) return tgSend(chatId, 'Этот пост уже в вишлисте.', tgOwnKeyboard(dup.rows[0].id));
  }
  const image = info.fileId ? await tgSaveMedia(userId, info.fileId) : null;
  const title = info.title || (info.channel ? `Вещь из «${info.channel}»` : 'Вещь из Telegram');
  const shop = info.channel || 'Telegram';
  const r = await pool.query(
    "INSERT INTO wishlist (user_id,title,shop,url,price,image,parse_status) VALUES ($1,$2,$3,$4,$5,$6,'done') RETURNING id",
    [userId, title, shop, info.postUrl, info.price, image]);
  const wid = r.rows[0].id;
  const note = info.postUrl ? 'Ссылки на магазин в посте нет — сохранил ссылку на сам пост.'
                            : 'Ссылки на магазин в посте нет, канал закрытый — сохранил название, цену и фото.';
  const text = `✓ ${title}${info.price ? ' — ' + info.price : ''}\n${note}\nНазвание можно поправить в приложении.`;
  if (info.fileId) {
    const s = await tgApi('sendPhoto', { chat_id: chatId, photo: info.fileId, caption: text.slice(0, 1000), reply_markup: { inline_keyboard: tgOwnKeyboard(wid) } });
    if (s && s.ok) return s;
  }
  return tgSend(chatId, text, tgOwnKeyboard(wid));
}

// Альбом приходит несколькими сообщениями подряд; собираем их 1,5 с и обрабатываем вместе
const tgAlbums = new Map();
function tgQueueAlbum(chatId, userId, msg) {
  const key = `${chatId}:${msg.media_group_id}`;
  let a = tgAlbums.get(key);
  if (!a) { a = { msgs: [], timer: null }; tgAlbums.set(key, a); }
  a.msgs.push(msg);
  clearTimeout(a.timer);
  a.timer = setTimeout(() => {
    tgAlbums.delete(key);
    a.msgs.sort((x, y) => x.message_id - y.message_id);
    tgHandlePost(chatId, userId, a.msgs).catch(e => console.error('[tg] album', e.message));
  }, 1500);
}

// ── TELEGRAM-БОТ: «Поделиться» → Telegram → SizeBook ─────────────────────────
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_BOT = (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
const TG_SECRET = TG_TOKEN ? crypto.createHash('sha256').update(TG_TOKEN + JWT_SECRET).digest('hex').slice(0, 32) : '';
async function tgApi(method, body) {
  if (!TG_TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    return await r.json().catch(() => null);
  } catch (e) { console.log('[tg]', method, 'error', e.message); return null; }
}
async function tgSend(chatId, text, keyboard) {
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  return tgApi('sendMessage', body);
}
// Карточка вещи: фото + название и цена; если Telegram не смог загрузить фото — просто текст
async function tgSendItem(chatId, e, wid, prefix = '✓ ') {
  const text = `${prefix}${e.title}${e.price ? ' — ' + e.price : ''}`;
  if (e.image) {
    const r = await tgApi('sendPhoto', { chat_id: chatId, photo: e.image, caption: text.slice(0, 1000),
      reply_markup: { inline_keyboard: tgOwnKeyboard(wid) } });
    if (r && r.ok) return r;
  }
  return tgSend(chatId, text, tgOwnKeyboard(wid));
}
// Кнопка «Уже моё» под товаром из вишлиста
const tgOwnKeyboard = (wid) => [[{ text: 'Уже моё — в мои вещи', callback_data: 'own:' + wid }]];
const TG_ZONE_SIZES = {
  tops: ['XS', 'S', 'M', 'L', 'XL', 'XXL'], outer: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
  bottoms: ['XS', 'S', 'M', 'L', 'XL', 'W28', 'W30', 'W32', 'W34', 'W36'],
  shoes: ['EU 36', 'EU 37', 'EU 38', 'EU 39', 'EU 40', 'EU 41', 'EU 42', 'EU 43', 'EU 44', 'EU 45', 'EU 46'],
  hats: ['S/M', 'L/XL', '56', '57', '58', '59', 'One Size'], acc: ['One Size', 'S', 'M', 'L'],
};
function tgSizeKeyboard(wid, zone) {
  const sizes = TG_ZONE_SIZES[zone] || TG_ZONE_SIZES.tops;
  const rows = [];
  for (let i = 0; i < sizes.length; i += 4) rows.push(sizes.slice(i, i + 4).map(v => ({ text: v, callback_data: `sz:${wid}:${v}` })));
  rows.push([{ text: 'Другой — укажу в приложении', callback_data: `sz:${wid}:` }]);
  return rows;
}
async function tgHandleCallback(cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const answer = (text) => tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: text || undefined });
  if (!chatId) return answer();
  const u = await pool.query('SELECT id FROM users WHERE tg_chat_id=$1', [chatId]);
  if (!u.rows[0]) return answer('Бот не подключён');
  const userId = u.rows[0].id;
  const data = String(cq.data || '');
  let m = data.match(/^own:(\d+)$/);
  if (m) {
    const w = (await pool.query('SELECT id, title FROM wishlist WHERE id=$1 AND user_id=$2', [m[1], userId])).rows[0];
    if (!w) return answer('Вещь не найдена');
    await answer();
    return tgSend(chatId, `Какой у вас размер?\n${w.title}`, tgSizeKeyboard(w.id, guessZone(w.title)));
  }
  m = data.match(/^sz:(\d+):(.{0,20})$/);
  if (m) {
    const out = await wishlistToItem(userId, m[1], { size: m[2] || null, source: 'tg' });
    if (!out) return answer('Вещь не найдена');
    if (out.existed && m[2]) {
      await pool.query('UPDATE items SET size=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3', [m[2], out.item.id, userId]);
    }
    await answer('Готово');
    await tgApi('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
    return tgSend(chatId, `✓ В ваших вещах: ${out.item.name}${m[2] ? ', размер ' + m[2] : ''}.\nПосадку (маломерит / в размер) можно отметить в приложении.`);
  }
  return answer();
}
async function tgSetWebhook() {
  const domain = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '');
  if (!TG_TOKEN || !domain) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${domain}/tg/webhook/${TG_SECRET}`, allowed_updates: ['message', 'callback_query'] }),
      signal: AbortSignal.timeout(10000),
    });
    console.log('[tg] setWebhook', r.status);
  } catch (e) { console.log('[tg] setWebhook error', e.message); }
}

app.get('/me/telegram', authenticateToken, async (req, res) => {
  try {
    if (!TG_TOKEN || !TG_BOT) return res.json({ enabled: false });
    const r = await pool.query('SELECT tg_chat_id, tg_link_code FROM users WHERE id=$1', [req.user.id]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'Не найден' });
    if (row.tg_chat_id) return res.json({ enabled: true, linked: true, bot: TG_BOT });
    let code = row.tg_link_code;
    if (!code) {
      code = crypto.randomBytes(12).toString('hex');
      await pool.query('UPDATE users SET tg_link_code=$1 WHERE id=$2', [code, req.user.id]);
    }
    res.json({ enabled: true, linked: false, bot: TG_BOT, link: `https://t.me/${TG_BOT}?start=${code}` });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/me/telegram/unlink', authenticateToken, async (req, res) => {
  try { await pool.query('UPDATE users SET tg_chat_id=NULL, tg_link_code=NULL WHERE id=$1', [req.user.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

const tgHits = new Map();
app.post('/tg/webhook/:secret', async (req, res) => {
  if (!TG_SECRET || req.params.secret !== TG_SECRET) return res.sendStatus(404);
  res.sendStatus(200); // Telegram ждёт быстрый ответ, остальное делаем после
  try {
    if (req.body && req.body.callback_query) return await tgHandleCallback(req.body.callback_query);
    const msg = req.body && req.body.message;
    if (!msg || !msg.chat || msg.chat.type !== 'private') return;
    const chatId = msg.chat.id;
    const text = String(msg.text || msg.caption || '');
    const now = Date.now();
    const hits = (tgHits.get(chatId) || []).filter(t => now - t < 60000);
    if (hits.length >= 20) return;
    hits.push(now); tgHits.set(chatId, hits);
    if (tgHits.size > 5000) tgHits.delete(tgHits.keys().next().value);

    const start = text.match(/^\/start(?:\s+([0-9a-f]{24}))?/i);
    if (start) {
      const code = start[1];
      if (code) {
        const u = await pool.query('UPDATE users SET tg_chat_id=$1, tg_link_code=NULL WHERE tg_link_code=$2 RETURNING id', [chatId, code]);
        if (u.rows[0]) return tgSend(chatId, 'Готово, Telegram подключён к SizeBook ✓\n\nТеперь в любом приложении магазина нажмите «Поделиться» → Telegram → этот чат, и вещь окажется в вашем вишлисте.');
        return tgSend(chatId, 'Ссылка для подключения устарела. Откройте SizeBook → Вишлист и нажмите «Подключить Telegram» ещё раз.');
      }
      const linked = await pool.query('SELECT id FROM users WHERE tg_chat_id=$1', [chatId]);
      return tgSend(chatId, linked.rows[0] ? 'Присылайте ссылки на товары, я добавлю их в ваш вишлист.' : 'Чтобы подключить бота, откройте SizeBook → Вишлист → «Подключить Telegram».');
    }
    const u = await pool.query('SELECT id FROM users WHERE tg_chat_id=$1', [chatId]);
    if (!u.rows[0]) return tgSend(chatId, 'Бот ещё не подключён. Откройте SizeBook → Вишлист → «Подключить Telegram».');
    const userId = u.rows[0].id;
    if (msg.media_group_id) return tgQueueAlbum(chatId, userId, msg);
    const isPost = !!(msg.forward_origin || msg.forward_from_chat || msg.photo || msg.video || msg.animation);
    if (!isPost && !tgCollectLinks([msg]).length) {
      return tgSend(chatId, 'Не нашёл ссылку на товар в сообщении. Пришлите её через «Поделиться» в приложении магазина или перешлите сюда пост из канала.');
    }
    await tgHandlePost(chatId, userId, [msg]);
  } catch (e) { console.error('[tg] webhook', e.message); }
});

const quickHits = new Map(); // key -> [timestamps]
app.post('/wishlist/quick', async (req, res) => {
  try {
    const b = req.body || {};
    const key = String(req.headers['x-add-key'] || b.key || '').trim();
    if (!/^[0-9a-f]{36}$/.test(key)) return res.status(401).json({ error: 'Неверный ключ' });
    const now = Date.now();
    const hits = (quickHits.get(key) || []).filter(t => now - t < 60000);
    if (hits.length >= 30) return res.status(429).json({ error: 'Слишком часто' });
    hits.push(now); quickHits.set(key, hits);
    if (quickHits.size > 2000) quickHits.delete(quickHits.keys().next().value);

    const u = await pool.query('SELECT id FROM users WHERE add_key=$1', [key]);
    if (!u.rows[0]) return res.status(401).json({ error: 'Неверный ключ' });
    const out = await addWishlistFromText(u.rows[0].id, String(b.url || b.text || b.link || ''));
    if (out.error) return res.status(400).json({ error: out.error });
    res.json({ ok: true, duplicate: out.duplicate || undefined, shop: out.host });
    if (out.enrich) out.enrich();
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка' }); }
});

app.patch('/wishlist/:id', authenticateToken, async (req, res) => {
  try {
    const received = !!(req.body && req.body.received);
    const r = await pool.query(
      `UPDATE wishlist SET received_at = ${received ? 'NOW()' : 'NULL'} WHERE id=$1 AND user_id=$2 RETURNING id, received_at`,
      [req.params.id, req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Не найдено' });
    res.json({ ok: true, received_at: r.rows[0].received_at });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка' }); }
});

app.delete('/wishlist/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM wishlist WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

// ── ПУБЛИЧНЫЙ ПРОФИЛЬ ─────────────────────────────────────────────────────────
// Публичный профиль по username закрыт: отдавал размеры и вишлист любого пользователя без токена
// и без учёта настроек шаринга. Фронт его не использует; публичный доступ — только через /share/:token.
app.get('/profile/:username', (req, res) => res.status(404).json({ error: 'Не найден' }));

// ── SHARE LINKS ──────────────────────────────────────────────────────────────
app.post('/share', authenticateToken, async (req, res) => {
  try {
    const { sections, expires_at } = req.body;
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'UPDATE share_links SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL',
      [req.user.id]
    );
    const r = await pool.query(
      'INSERT INTO share_links (user_id, token, sections, expires_at) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.id, token, JSON.stringify(sections || {}), expires_at || null]
    );
    res.json(r.rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

app.get('/share', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM share_links WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
      [req.user.id]
    );
    if (!r.rows.length) return res.json(null);
    const link = r.rows[0];
    if (link.expires_at && new Date(link.expires_at) < new Date()) return res.json(null);
    res.json(link);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

app.post('/share/revoke', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      'UPDATE share_links SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL',
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

app.get('/share/:token', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM share_links WHERE token=$1 AND revoked_at IS NULL',
      [req.params.token]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Ссылка недействительна' });
    const link = r.rows[0];
    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Ссылка истекла' });
    }
    const sections = link.sections || {};
    const result = { token: link.token, expires_at: link.expires_at, sections };

    if (sections.sizes) {
      const sr = await pool.query('SELECT data FROM sizes WHERE user_id=$1', [link.user_id]);
      let sizesData = sr.rows[0]?.data || {};
      const excl = Array.isArray(sections.excluded_size_keys) ? sections.excluded_size_keys : [];
      if (excl.length) {
        sizesData = Object.fromEntries(
          Object.entries(sizesData).filter(([k]) => !excl.includes(k))
        );
      }
      result.sizes = sizesData;
      // Размеры по брендам из «Моих вещей» (без заметок, ссылок и фото); отключается sections.items === false
      if (sections.items !== false) {
        const ir = await pool.query(
          `SELECT brand, zone, name, size, fit FROM items
           WHERE user_id=$1 AND COALESCE(brand,'')<>'' AND COALESCE(size,'')<>''
           ORDER BY lower(brand), zone, id`, [link.user_id]
        );
        result.brand_sizes = ir.rows;
      }
    }

    if (sections.wishlist) {
      const wr = await pool.query(
        'SELECT * FROM wishlist WHERE user_id=$1 AND received_at IS NULL ORDER BY id DESC', [link.user_id]
      );
      const excl = Array.isArray(sections.excluded_wishlist_ids) ? sections.excluded_wishlist_ids : [];
      result.wishlist = excl.length
        ? wr.rows.filter(item => !excl.includes(item.id))
        : wr.rows;
    }

    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

// ── ITEMS ─────────────────────────────────────────────────────────────────────
const ITEM_FITS = ['small', 'true', 'large'];
const ITEM_SOURCES = ['manual', 'link', 'wishlist', 'tg'];
function cleanItemFields(b) {
  const str = (v, n) => (v === undefined ? undefined : (v === null ? null : String(v).trim().slice(0, n) || null));
  const out = {
    zone: str(b.zone, 40), name: str(b.name, 200), brand: str(b.brand, 80), size: str(b.size, 40),
    note: str(b.note, 500), shop: str(b.shop, 80), fit: str(b.fit, 10),
    url: str(b.url, 2000), image: str(b.image, 2000), my_photo: str(b.my_photo, 2000),
  };
  for (const k of ['url', 'image', 'my_photo']) {
    if (out[k] && !/^https?:\/\//i.test(out[k])) out[k] = null;
  }
  if (out.fit && !ITEM_FITS.includes(out.fit)) out.fit = null;
  return out;
}

app.get('/items', authenticateToken, async (req, res) => {
  try {
    const zone = req.query.zone;
    const r = zone
      ? await pool.query('SELECT * FROM items WHERE user_id=$1 AND zone=$2 ORDER BY id ASC', [req.user.id, zone])
      : await pool.query('SELECT * FROM items WHERE user_id=$1 ORDER BY id ASC', [req.user.id]);
    res.json(r.rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

app.post('/items', authenticateToken, async (req, res) => {
  try {
    const f = cleanItemFields(req.body || {});
    if (!f.zone || !f.name) return res.status(400).json({ error: 'zone и name обязательны' });
    const source = ITEM_SOURCES.includes(req.body.source) ? req.body.source : 'manual';
    const r = await pool.query(
      `INSERT INTO items (user_id, zone, name, brand, size, note, url, image, shop, fit, source, my_photo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.user.id, f.zone, f.name, f.brand || null, f.size || null, f.note || null,
       f.url || null, f.image || null, f.shop || null, f.fit || null, source, f.my_photo || null]
    );
    res.json(r.rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

// Правка вещи: меняются только присланные поля
app.patch('/items/:id', authenticateToken, async (req, res) => {
  try {
    const f = cleanItemFields(req.body || {});
    const cols = ['zone', 'name', 'brand', 'size', 'note', 'url', 'image', 'shop', 'fit', 'my_photo'];
    const sets = [], vals = [];
    for (const c of cols) {
      if (f[c] === undefined) continue;
      if ((c === 'zone' || c === 'name') && !f[c]) return res.status(400).json({ error: c + ' не может быть пустым' });
      vals.push(f[c]); sets.push(`${c}=$${vals.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Нечего менять' });
    vals.push(req.params.id, req.user.id);
    const r = await pool.query(
      `UPDATE items SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length - 1} AND user_id=$${vals.length} RETURNING *`,
      vals
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Не найдено' });
    res.json(r.rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

app.delete('/items/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM items WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

// Категория вещи по названию товара (для ссылки, вишлиста и бота). null — не угадали.
const ZONE_GUESS = [
  ['shoes', /кроссовк|кед[ыа ]|ботин|сапог|туфл|лофер|мокасин|сандал|босонож|шлепан|слипон|сникер|дерби|оксфорд|челси|угги|sneaker|trainer|\bshoes?\b|\bboots?\b|loafer|sandal|\bmules?\b/i],
  ['hats', /шапк|кепк|бейсболк|панам|берет|шляп|\bhat\b|\bcap\b|beanie|bucket/i],
  ['outer', /куртк|пуховик|пальто|плащ|парк[аи]|тренч|ветровк|бомбер|жилет|анорак|дублен|шуб|jacket|coat|parka|puffer|trench|bomber|gilet|vest\b/i],
  ['bottoms', /джинс|брюк|штан|шорт|юбк|леггин|лосин|чинос|карго|jeans|trouser|pants|shorts|skirt|legging|chino/i],
  ['tops', /футболк|рубашк|поло|лонгслив|свитшот|худи|толстовк|свитер|джемпер|кардиган|водолазк|топ\b|майк|блуз|t-shirt|tee\b|shirt|polo|hoodie|sweatshirt|sweater|jumper|cardigan|blouse|\btop\b/i],
  ['acc', /ремень|ремн|кольц|сумк|рюкзак|шарф|перчатк|носк|очки|часы|\bbelt|\bring\b|\bbag\b|backpack|scarf|glove|\bsocks?\b|sunglass|\bwatch\b/i],
];
function guessZone(title) {
  const t = String(title || '');
  for (const [zone, re] of ZONE_GUESS) if (re.test(t)) return zone;
  return null;
}

// Вишлист → «Мои вещи»: создаёт вещь из записи вишлиста (и отмечает её полученной)
async function wishlistToItem(userId, wishlistId, extra) {
  const w = (await pool.query('SELECT * FROM wishlist WHERE id=$1 AND user_id=$2', [wishlistId, userId])).rows[0];
  if (!w) return null;
  const ex = (await pool.query('SELECT * FROM items WHERE user_id=$1 AND wishlist_id=$2 LIMIT 1', [userId, wishlistId])).rows[0];
  if (ex) return { item: ex, existed: true };
  const f = cleanItemFields(extra || {});
  const zone = f.zone || guessZone(w.title) || 'tops';
  const r = await pool.query(
    `INSERT INTO items (user_id, zone, name, brand, size, note, url, image, shop, fit, source, wishlist_id, my_photo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [userId, zone, f.name || w.title, f.brand || null, f.size || w.size || null, f.note || null,
     w.url || null, f.image || w.image || null, w.shop || null, f.fit || null, (extra && extra.source) === 'tg' ? 'tg' : 'wishlist', w.id, f.my_photo || null]
  );
  await pool.query('UPDATE wishlist SET received_at=COALESCE(received_at, NOW()) WHERE id=$1 AND user_id=$2', [w.id, userId]);
  return { item: r.rows[0], existed: false };
}

app.post('/wishlist/:id/to-items', authenticateToken, async (req, res) => {
  try {
    const out = await wishlistToItem(req.user.id, req.params.id, req.body || {});
    if (!out) return res.status(404).json({ error: 'Не найдено' });
    res.json(out);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

app.post('/items/guess-zone', authenticateToken, (req, res) => {
  res.json({ zone: guessZone(req.body && req.body.title) });
});

// ── ПАРСЕР ────────────────────────────────────────────────────────────────────
// Утилита таймингов: обёртка засекает мс на каждый шаг парсинга.
// Используется для диагностики скорости (см. /parse ответ: _ms, _steps).
function timer() {
  const start = Date.now();
  const steps = [];
  return {
    mark(label, extra) { steps.push({ label, ms: Date.now() - start, ...(extra || {}) }); },
    total() { return Date.now() - start; },
    steps() { return steps; },
  };
}

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
  'Connection': 'keep-alive',
};

// Headless browser — синглтон, переиспользуется между запросами
// Парсим RU_PROXY_URL в формат, который понимает Playwright (server/username/password)
function getPlaywrightProxyConfig() {
  if (!RU_PROXY_URL) return null;
  try {
    const u = new URL(RU_PROXY_URL);
    return {
      server: `${u.protocol}//${u.hostname}:${u.port}`,
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
  } catch (e) {
    console.log('[ru-proxy] не удалось распарсить RU_PROXY_URL для Playwright:', e.message);
    return null;
  }
}

let _browser = null;
async function getHeadlessBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || 'chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  _browser.on('disconnected', () => { _browser = null; });
  return _browser;
}

// Для сайтов с JS-челленджем (Servicepipe и др.)
// useRuProxy=true — пускает headless-браузер через РФ-прокси (для WB/Ozon,
// где блокировка идёт по гео-IP, а не только по антибот-фингерпринту).
async function parseViaPlaywright(url, locale = 'ru-RU', useRuProxy = false) {
  try {
    const browser = await getHeadlessBrowser();
    const proxyConfig = useRuProxy ? getPlaywrightProxyConfig() : null;
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
      locale,
      extraHTTPHeaders: { 'Accept-Language': `${locale},en;q=0.8` },
      ...(proxyConfig ? { proxy: proxyConfig } : {}),
    });
    console.log(`[playwright] контекст создан${proxyConfig ? ' с РФ-прокси' : ''} для ${url}`);
    const page = await ctx.newPage();
    await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    } catch (_) {}
    await page.waitForTimeout(2000);

    const result = await page.evaluate(() => {
      let title = null, price = null, image = null;
      for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(el.textContent);
          for (const obj of (data['@graph'] || (Array.isArray(data) ? data : [data]))) {
            if (obj['@type'] !== 'Product') continue;
            title = title || obj.name || null;
            const imgs = obj.image;
            if (!image) image = Array.isArray(imgs) ? (imgs[0]?.contentUrl || imgs[0] || null) : (imgs?.contentUrl || imgs || null);
            const offer = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
            if (offer?.price && !price) {
              const cur = offer.priceCurrency || '';
              price = cur ? `${offer.price} ${cur}` : String(offer.price);
            }
          }
        } catch (_) {}
      }
      const og = k => document.querySelector(`meta[property="${k}"]`)?.content;
      title = title || og('og:title') || null;
      image = image || og('og:image') || null;
      if (!price) {
        const p = og('og:price:amount') || og('product:price:amount');
        const c = og('og:price:currency') || og('product:price:currency');
        if (p) price = c ? `${p} ${c}` : p;
      }
      // Fallback для 12storeez — ищем картинку в DOM и в src img-тегов
      if (!image) {
        const imgEl = document.querySelector('.TempProductMedia img, .TempProductMediaItem__image, [class*="ProductMedia"] img, [class*="product-media"] img, [class*="Gallery"] img');
        if (imgEl) image = imgEl.src || imgEl.dataset.src || null;
      }
      if (!image) {
        // Ищем любой URL image.12storeez.com в тексте страницы
        const html = document.documentElement.innerHTML;
        const m = html.match(/https:\/\/image\.12storeez\.com\/images\/[^"'\s]+/);
        if (m) image = m[0].replace(/\/\d+xP_/, '/800xP_');
      }
      // Фолбэк цены по видимому DOM (Farfetch и похожие SPA, где og:price/JSON-LD
      // не содержат актуальную цену со скидкой)
      if (!price) {
        const candidates = document.querySelectorAll(
          '[data-testid*="price" i], [data-component*="Price" i], [class*="price" i]'
        );
        for (const el of candidates) {
          const t = (el.textContent || '').trim();
          if (t && t.length < 60 && /[£$€₽]\s?\d|\d[\s.,]?\d{2,3}\s?[£$€₽]/.test(t)) {
            const m = t.match(/[£$€₽]\s?[\d\s.,]+|\d[\d\s.,]*\s?[£$€₽]/);
            price = m ? m[0].trim() : t;
            break;
          }
        }
      }
      return { title, price, image };
    });

    await ctx.close();
    return result;
  } catch (e) {
    console.error('Playwright parse error:', e.message);
    return null;
  }
}

// Wildberries — публичный CDN, не требует антибота
async function parseWildberries(url) {
  try {
    // Поддерживаем URL с /detail.aspx и без trailing slash
    const nm = url.match(/\/catalog\/(\d+)/)?.[1];
    if (!nm) {
      console.log(`[wb] не удалось извлечь артикул из URL: ${url}`);
      return null;
    }
    console.log(`[wb] артикул: ${nm}, id=${Number(nm)}`);
    const id = Number(nm);
    const vol = Math.floor(id / 100000);
    const part = Math.floor(id / 1000);

    // Вычисляем начальный basket по таблице (может устареть для новых артикулов)
    const startBasket = (() => {
      const t = [143,287,431,719,1007,1061,1115,1169,1313,1601,1655,1919,2045,2189,2405,
                 2621,2837,3053,3269,3485,3701,3917,4133,4349,4565,4781,4997,5213,5429,
                 5645,5861,6077,6293,6509,6725,6941,7157,7373,7589,7805];
      const i = t.findIndex(v => vol <= v);
      return i === -1 ? t.length + 1 : i + 1;
    })();

    const cdnHeaders = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };

    // Цена идёт через Firecrawl(RU) и не зависит от basket scan — стартуем
    // запрос сразу, чтобы два медленных шага шли параллельно, а не подряд.
    // Цена: сервис fetcher (браузер ловит JSON карточки WB, ~4–10 с). Если он недоступен —
    // старый путь через Scrape.do/Firecrawl с российским IP.
    let priceSource = 'none';
    const fetcherPromise = viaFetcher(url, 50000);
    const pricePromise = fetcherPromise.then(async (d) => {
      if (d && d.price) { priceSource = 'fetcher'; return fmtRub(d.price); }
      if (d && d.available === false) { priceSource = 'fetcher'; return 'Нет в наличии'; }
      if (FETCHER_URL && d === null) console.log('[wb] fetcher не дал цену, пробуем Scrape.do/Firecrawl');
      const fc = await parseViaRu(url).catch(() => null);
      if (fc && fc.price) { priceSource = 'scrapedo_or_firecrawl'; return fc.price; }
      return null;
    }).catch(e => { console.log(`[wb] цена ошибка: ${e.message}`); return null; });

    // Параллельный перебор basket-01..basket-60: не зависим от устаревшей
    // таблицы порогов (WB регулярно добавляет новые basket-сервера, из-за
    // чего фиксированная таблица стабильно устаревает для новых артикулов).
    // Все запросы летят одновременно — быстрее и надёжнее последовательного перебора.
    let card = null;
    let foundBasket = null;
    try {
      const tryBasket = async (num) => {
        const bStr = String(num).padStart(2, '0');
        const tryUrl = `https://basket-${bStr}.wbbasket.ru/vol${vol}/part${part}/${nm}/info/ru/card.json`;
        try {
          const r = await fetch(tryUrl, { headers: cdnHeaders, signal: AbortSignal.timeout(5000) });
          if (r.ok) return { bStr, json: await r.json() };
        } catch (_) {}
        return null;
      };

      // Шаг 1: пробуем предсказанный basket
      const predicted = startBasket;
      const fast = await tryBasket(predicted);
      if (fast) { card = fast.json; foundBasket = fast.bStr; console.log(`[wb] basket hit: ${foundBasket} (predicted)`); }

      // Шаг 2: если не попали — расширяем ±20 параллельно (WB добавляет новые серверы)
      if (!card) {
        const RANGE = 20;
        const candidates = new Set();
        for (let d = 1; d <= RANGE; d++) {
          if (predicted - d >= 1) candidates.add(predicted - d);
          if (predicted + d <= 70) candidates.add(predicted + d);
        }
        const attempts = [...candidates].map(num => tryBasket(num));
        const results = await Promise.all(attempts);
        const found = results.find(r => r && r.json);
        if (found) { card = found.json; foundBasket = found.bStr; }
        console.log(`[wb] basket scan ±${RANGE} around ${predicted}: найден ${foundBasket || 'NONE'}, checked=${candidates.size}`);
      }
    } catch (e) {
      console.log(`[wb] basket scan ошибка: ${e.message}`);
    }

    if (!card) {
      console.log(`[wb] basket-01..60 не нашли card.json для nm=${nm} (vol=${vol}, part=${part}). Пробуем Firecrawl`);
      const d = await fetcherPromise;
      const price = await pricePromise;
      return { title: d?.title || null, price, image: null, _wb_from_firecrawl: false, _wb_price_source: priceSource };
    }
    console.log(`[wb] нашли basket-${foundBasket}, ключи:`, Object.keys(card).slice(0, 8));
    const base = `https://basket-${foundBasket}.wbbasket.ru/vol${vol}/part${part}/${nm}`;
    const title = card.imt_name || card.name || null;
    const image = `${base}/images/big/1.webp`;

    if (!title) {
      const d = await fetcherPromise;
      return { title: d?.title || null, price: await pricePromise, image, _wb_price_source: priceSource };
    }

    // ── ЦЕНА WB ──────────────────────────────────────────────────────────
    // card.wb.ru / search.wb.ru не отдают данные «голым» запросам с серверных IP (403/429,
    // в т.ч. с TLS-отпечатком браузера). Цену берём из сервиса fetcher: настоящий браузер
    // открывает страницу товара и перехватывает JSON карточки, который WB сам себе загружает.
    const price = await pricePromise;
    console.log(`[wb] цена: ${price || 'не найдена'} (${priceSource})`);

    return { title, price, image, _wb_price_source: priceSource };
  } catch (e) {
    console.log(`[wb] parseWildberries ошибка: ${e.message}`);
    return null;
  }
}

// ── Fetcher: отдельный сервис с настоящим браузером (Camoufox) для Ozon и WB ──
// Сервис `fetcher` в том же проекте Railway, ходим по внутренней сети.
// Он проходит JS-проверку антибота как обычный посетитель и отдаёт название/цену/картинку.
const FETCHER_URL = (process.env.FETCHER_URL || '').replace(/\/$/, '');
const FETCHER_SECRET = process.env.FETCHER_SECRET || '';
const fmtRub = (n) => (n == null ? null : `${Math.round(Number(n))} ₽`);

async function viaFetcher(url, timeoutMs = 75000) {
  if (!FETCHER_URL || !FETCHER_SECRET) return null;
  const t0 = Date.now();
  try {
    const r = await fetch(`${FETCHER_URL}/product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-fetcher-secret': FETCHER_SECRET },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const d = await r.json().catch(() => null);
    console.log(`[fetcher] ${new URL(url).hostname} http=${r.status} ok=${d && d.ok} ms=${Date.now() - t0} err=${d && d.error || ''}`);
    return d && d.ok ? d : null;
  } catch (e) {
    console.log(`[fetcher] ошибка: ${e.message} (ms=${Date.now() - t0})`);
    return null;
  }
}

// Ozon (см. PARSER_CONTEXT.md): закрыт JS-антиботом и слайдер-капчей для «голых» HTTP-запросов (fetch, Firecrawl,
// Scrape.do — проверено 09–10.2026). Работает только настоящий браузер → сервис fetcher.
async function parseOzon(url) {
  // до ~2 мин: если сессия Ozon в fetcher «отозвана», он открывает новую (несколько попыток)
  const d = await viaFetcher(url, 140000);
  if (!d) return { title: null, price: null, image: null, _ozon_steps: [{ step: 'fetcher', ok: false }] };
  return {
    title: d.title || null,
    // Показываем цену, которую Ozon выводит крупно (по Ozon-карте), как видит её пользователь в приложении
    price: (d.card_price || d.price) ? fmtRub(d.card_price || d.price) : (d.available === false ? 'Нет в наличии' : null),
    image: d.image || null,
    _ozon_steps: [{ step: 'fetcher', ok: true, ms: d.ms, price: d.price || null, card_price: d.card_price || null }],
  };
}

// Для сайтов с Cloudflare (Farfetch и др.) — внешние OG-парсеры
async function parseViaJsonlink(url) {
  try {
    const r = await fetch(`https://jsonlink.io/api/extract?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return null;
    const d = await r.json();
    return { title: d.title || null, image: d.images?.[0] || null, price: null };
  } catch (_) { return null; }
}

async function parseViaIframely(url) {
  try {
    const r = await fetch(`https://open.iframe.ly/api/oembed?url=${encodeURIComponent(url)}&origin=embedly`, {
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return null;
    const d = await r.json();
    return { title: d.title || null, image: d.thumbnail_url || null, price: null };
  } catch (_) { return null; }
}

// Firecrawl — обходит антибот-защиту, возвращает чистый markdown/html
// ── Scrape.do (основной платный провайдер) ───────────────────────────────────
const SD_DAILY_LIMIT = Number(process.env.SCRAPEDO_DAILY_LIMIT || 300); // запросов super (по 10 кредитов) в сутки
const sdUsage = { day: '', n: 0 };
function sdAllowed() {
  const d = new Date().toISOString().slice(0, 10);
  if (sdUsage.day !== d) { sdUsage.day = d; sdUsage.n = 0; }
  if (sdUsage.n >= SD_DAILY_LIMIT) return false;
  sdUsage.n++; return true;
}
const BLOCK_TITLE_RE = /^(access denied|forbidden|attention required|just a moment|are you a robot|error \d{3}|not found|404|403|доступ ограничен|подтвердите|проверка|страница не найдена|сайт |amazon\.com$|uniqlo$|farfetch|net-a-porter|puma - официальный|yandex$)/i;

async function parseViaScrapedo(url, { geo = null } = {}) {
  if (!process.env.SCRAPEDO_TOKEN) return null;
  // Хеджирование: Scrape.do иногда зависает на ротации прокси (успешные ответы идут за 2–5 с).
  // Если первый запрос не ответил за 6 с — стартуем второй, берём первый успешный.
  const attempt = async () => {
    if (!sdAllowed()) { console.log('[scrapedo] дневной лимит исчерпан'); return null; }
    const r = await fetchViaScrapedo(url, { super: true, geo, timeout: 14000 });
    console.log(`[scrapedo] ${new URL(url).hostname} http=${r.http} ms=${r.ms} cost=${r.cost} remaining=${r.remaining} ${r.error || ''}`);
    if (!r.html || r.http !== 200) return null;
    const p = parseProductFromHtml(r.html, url);
    if (p.title && BLOCK_TITLE_RE.test(p.title.trim())) p.title = null;
    return (p.title || p.price || p.image) ? p : null;
  };
  return new Promise((resolve) => {
    let started = 0, finished = 0, done = false, timer = null;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const run = () => {
      started++;
      attempt().then(onResult, () => onResult(null));
    };
    const onResult = (v) => {
      finished++;
      if (v) return finish(v);
      if (started < 2) { clearTimeout(timer); return run(); } // первый вернул пусто — сразу повтор с новым прокси
      if (finished >= started) finish(null);
    };
    run();
    timer = setTimeout(() => { if (!done && started < 2) run(); }, 6000);
  });
}

// ── Стратегии по магазинам ───────────────────────────────────────────────────
// tiers: порядок источников. direct = обычный fetch, wa = fetch под превью-ботом мессенджера, sd = Scrape.do.
// Результаты замеров 08.10.2026 (/debug coverage probe). Неизвестный хост: direct+wa параллельно -> sd.
const HOST_STRATEGY = {
  'lamoda.ru': { tiers: ['sd'], geo: 'ru' }, 'aliexpress.ru': { tiers: ['sd'], geo: 'ru' },
  'kupivip.ru': { tiers: ['sd'], geo: 'ru' }, 'gloria-jeans.ru': { tiers: ['direct', 'sd'], geo: 'ru' },
  '12storeez.com': { tiers: ['direct', 'sd'], geo: 'ru' }, 'market.yandex.ru': { tiers: ['direct', 'sd'], geo: 'ru' },
  'farfetch.com': { tiers: ['sd'], geo: null }, 'hm.com': { tiers: ['sd'], geo: null },
  'ssense.com': { tiers: ['wa', 'sd'], geo: null }, 'asos.com': { tiers: ['wa', 'sd'], geo: null },
  'net-a-porter.com': { tiers: ['sd'], geo: null }, 'uniqlo.com': { tiers: ['direct', 'sd'], geo: null },
  'amazon.com': { tiers: ['direct', 'sd'], geo: null },
  // Закрытые антиботом (проверено 08.10.2026): быстро отдаём пусто, не жжём кредиты и время
  'sportmaster.ru': { tiers: ['direct+wa'], noFallback: true }, 'tsum.ru': { tiers: ['direct+wa'], noFallback: true },
  'ru.puma.com': { tiers: ['direct+wa'], noFallback: true },
  'befree.ru': { tiers: ['direct'] }, 'brandshop.ru': { tiers: ['direct'] }, 'street-beat.ru': { tiers: ['direct'] },
  'detmir.ru': { tiers: ['direct', 'wa'] }, 'bask.ru': { tiers: ['direct'] }, 'nike.com': { tiers: ['direct', 'sd'], geo: null },
};
function strategyFor(host) {
  const h = host.replace(/^www\d?\./, '');
  const key = Object.keys(HOST_STRATEGY).find(k => h === k || h.endsWith('.' + k));
  if (key) return HOST_STRATEGY[key];
  return { tiers: ['direct+wa', 'sd'], geo: h.endsWith('.ru') ? 'ru' : null };
}

const WA_UA = 'WhatsApp/2.23.20.0 A';
async function fetchParse(url, ua) {
  try {
    const r = await fetch(url, { headers: { ...FETCH_HEADERS, ...(ua ? { 'User-Agent': ua } : {}) }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
    if (!r.ok && r.status >= 500) return null;
    const p = parseProductFromHtml(await r.text(), url);
    if (p.title && BLOCK_TITLE_RE.test(p.title.trim())) p.title = null;
    return p;
  } catch (_) { return null; }
}

// Универсальный каскад по стратегии магазина. Идём дальше, только если нет названия, картинки или цены.
async function parseByStrategy(url, host, t) {
  const st = strategyFor(host);
  let acc = { title: null, price: null, image: null };
  const complete = (a) => a.title && a.image && a.price;
  for (const tier of st.tiers) {
    if (complete(acc)) break;
    let r = null;
    if (tier === 'direct') r = await fetchParse(url, null);
    else if (tier === 'wa') r = await fetchParse(url, WA_UA);
    else if (tier === 'direct+wa') {
      const [a, b] = await Promise.all([fetchParse(url, null), fetchParse(url, WA_UA)]);
      r = mergeParseResults(a, b);
    } else if (tier === 'sd') r = await parseViaScrapedo(url, { geo: st.geo });
    t.mark('tier:' + tier, { title: !!r?.title, price: !!r?.price, image: !!r?.image });
    acc = mergeParseResults(acc, r);
  }
  // Запасной вариант на Firecrawl, если Scrape.do недоступен/не сработал и нет названия
  if (!acc.title && !st.noFallback && process.env.FIRECRAWL_API_KEY) {
    const fc = await parseViaFirecrawl(url, { waitFor: 4000, country: st.geo === 'ru' ? 'RU' : null });
    t.mark('tier:firecrawl', { title: !!fc?.title, price: !!fc?.price, image: !!fc?.image });
    acc = mergeParseResults(acc, fc);
  }
  // Последний шанс для названия/картинки: внешние OG-парсеры (цену не отдают)
  if ((!acc.title || !acc.image) && !st.noFallback) {
    const jl = await parseViaJsonlink(url);
    t.mark('tier:jsonlink', { title: !!jl?.title, image: !!jl?.image });
    acc = mergeParseResults(acc, jl);
  }
  return acc;
}

async function parseViaRu(url) {
  const sd = await parseViaScrapedo(url, { geo: 'ru' });
  if (sd && (sd.title || sd.price)) return sd;
  return parseViaFirecrawl(url, { waitFor: 6000, country: 'RU' });
}

async function parseViaFirecrawl(url, { waitFor = 4000, country = null, proxy = null } = {}) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) { console.log('[firecrawl] FIRECRAWL_API_KEY не задан в env'); return null; }
  try {
    const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(Object.assign({
        url,
        formats: ['html'],
        onlyMainContent: false,
        timeout: 30000,
        waitFor,
      }, country ? { location: { country } } : {}, proxy ? { proxy } : {})),
      signal: AbortSignal.timeout(50000),
    });
    console.log(`[firecrawl] HTTP ${r.status}`);
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      console.log(`[firecrawl] error body: ${errBody.slice(0, 500)}`);
      return null;
    }
    const d = await r.json();
    if (!d.success) {
      console.log(`[firecrawl] success=false, ответ:`, JSON.stringify(d).slice(0, 500));
      return null;
    }
    const html = d.data?.html;
    const meta = d.data?.metadata || {};
    console.log(`[firecrawl] получено HTML: ${html ? html.length : 0} байт, metadata.title=${meta.title || '—'}`);
    if (!html) return null;
    if (html.length < 3000) console.log(`[firecrawl] короткий HTML (возможно заглушка):`, html.slice(0, 500));

    const result = parseProductFromHtml(html, url);
    // Firecrawl иногда отдаёт HTML без <head> (нет title/og/JSON-LD в теле) —
    // в этом случае title/image добираем из собственных metadata Firecrawl,
    // но не если это та же заглушка антибота/SPA-загрузки.
    const blockPatterns = /^(access denied|forbidden|attention required|just a moment|are you a robot|error \d{3}|flomni|похоже,? нет соединения|нет соединения с интернетом)/i;
    const metaTitleOk = meta.title && !blockPatterns.test(meta.title.trim());
    if (!result.title && metaTitleOk) result.title = meta.title;
    if (!result.image && (meta.ogImage || meta.image)) result.image = meta.ogImage || meta.image;
    console.log(`[firecrawl] result:`, result);
    return result;
  } catch (e) {
    console.log(`[firecrawl] error:`, e.message);
    return null;
  }
}

// Универсальный HTML-парсер
function parseProductFromHtml(html, url) {
  const $ = cheerio.load(html);
  let title = null, price = null, image = null;

  // 1. JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        let obj = item['@type'] === 'Product' ? item : null;
        if (!obj && item['@graph']) obj = item['@graph'].find(x => x['@type'] === 'Product');
        if (!obj) continue;
        title = title || obj.name || null;
        const img = obj.image;
        image = image || (Array.isArray(img) ? img[0] : img) || null;
        const offer = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
        if (offer?.price) {
          const cur = offer.priceCurrency || '';
          price = price || (cur ? `${offer.price} ${cur}` : String(offer.price));
        }
      }
    } catch (_) {}
  });

  // 2. OpenGraph
  title = title || $('meta[property="og:title"]').attr('content') || null;
  image = image || $('meta[property="og:image"]').attr('content') || null;
  // Если вместо названия товара — только имя магазина (Спортмастер и т.п.), берём h1 или <title> без хвоста магазина
  {
    const brand = (() => { try { return new URL(url).hostname.replace(/^(www|m)\./, '').split('.')[0].toLowerCase(); } catch (_) { return ''; } })();
    const isShopName = t => { const x = (t || '').trim().toLowerCase().replace(/[^a-zа-яё0-9]/g, ''); return !x || x === brand || /^(спортмастер|sportmaster|интернетмагазин.*)$/.test(x); };
    if (isShopName(title)) {
      const clean = t => (t || '').replace(/\s+/g, ' ').split(/\s+[|—–]\s+|\s+-\s+(?=[^-]*$)/)[0]
        .replace(/\s*(купить|заказать)\b.*$/i, '').trim();
      const cand = [$('h1').first().text(), $('title').first().text()].map(clean).find(t => t && !isShopName(t));
      title = cand || null;
    }
  }
  if (!price) {
    const p = $('meta[property="product:price:amount"]').attr('content');
    const c = $('meta[property="product:price:currency"]').attr('content');
    if (p) price = c ? `${p} ${c}` : p;
  }
  if (!price) {
    // Farfetch и другие сайты кладут цену в og:price:* вместо product:price:*
    const p = $('meta[property="og:price:amount"]').attr('content');
    const c = $('meta[property="og:price:currency"]').attr('content');
    if (p) price = c ? `${p} ${c}` : p;
  }

  // 3. __NEXT_DATA__ (Zara, Mytheresa и другие Next.js)
  try {
    const nextRaw = $('#__NEXT_DATA__').html();
    if (nextRaw) {
      const pp = JSON.parse(nextRaw)?.props?.pageProps;
      // Zara
      const zp = pp?.product || pp?.initialData?.product;
      if (zp) {
        title = title || zp.name || null;
        const col = zp.detail?.colors?.[0] || zp.colors?.[0];
        if (!image && col?.images?.length) image = col.images[0].url || null;
        const zpr = zp.price || zp.detail?.price;
        if (!price && zpr) {
          const val = zpr.value || zpr.price;
          if (val) price = zpr.currency ? `${val} ${zpr.currency}` : String(val);
        }
      }
      // Другие Next.js магазины
      const pd = pp?.productDetails || pp?.initialData?.productView;
      if (pd) {
        title = title || pd.name || pd.shortDescription || null;
        const imgs = pd.images || pd.colors?.[0]?.images;
        if (!image && imgs?.length) image = imgs[0].url || imgs[0].src || null;
        const pi = pd.priceInfo || pd.price;
        if (!price && pi) {
          const val = pi.finalPrice || pi.price || pi.value;
          const cur = pi.currencyCode || pi.currency || '';
          if (val) price = cur ? `${val} ${cur}` : String(val);
        }
      }
    }
  } catch (_) {}

  // 4. 12storeez TempProductPage (Firecrawl возвращает статический HTML без head)
  if (!title) title = $('.ProductSummary__title').first().text().trim() || null;
  if (!price) {
    const cost = $('.ProductSummary__cost').first().text().trim();
    if (cost) price = cost.replace(/\s+/g, ' ').trim() + (cost.includes('₽') ? '' : ' ₽');
  }
  if (!image) {
    // Пробуем src и data-src (lazy loading), игнорируем placeholder-ы
    const imgEl = $('.TempProductMedia img, .TempProductMediaItem__image').first();
    const imgSrc = imgEl.attr('src') || imgEl.attr('data-src') || null;
    if (imgSrc && imgSrc.startsWith('http') && !imgSrc.includes('/catalog/')) {
      image = imgSrc;
    }
  }
  if (!image) {
    // Fallback: ищем любой URL image.12storeez.com в HTML и апгрейдим до 800xP
    const m = html.match(/https:\/\/image\.12storeez\.com\/images\/[^"'\s]+/);
    if (m) image = m[0].replace(/\/\d+xP_/, '/800xP_');
  }

  // 4b. window._site (12storeez и другие сайты с Vue/Nuxt)
  if (!title || !price || !image) {
    try {
      // Ищем Object.assign(window._site.data, {...product...})
      const siteDataMatch = html.match(/Object\.assign\(window\._site\.data,\s*(\{[\s\S]*?"product"[\s\S]*?\})\s*\);/);
      if (siteDataMatch) {
        const siteData = JSON.parse(siteDataMatch[1]);
        const p = siteData.product;
        if (p) {
          title = title || p.title || p.ecommerce?.name || null;
          price = price || (p.price ? `${p.price} ₽` : null);
          const imgs = p.images;
          if (!image && Array.isArray(imgs) && imgs.length) {
            const variant = imgs[0].variants?.find(v => v.name === 'PRODUCT_PREVIEW_PRODUCT_LIST') || imgs[0].variants?.[0];
            image = variant?.url || null;
          }
        }
      }
    } catch (_) {}
  }

  // 5. Fallback — title страницы
  if (!title) title = $('title').text().trim().split('|')[0].split('-')[0].trim() || null;
  if (title?.length > 120) title = title.slice(0, 120).trim();

  // 6. Фолбэк цены по видимому тексту DOM — на случай если HTML пришёл
  // без <head> (JSON-LD/OG недоступны), но тело страницы уже отрендерено
  // JS (актуально для Firecrawl с waitFor)
  if (!price) {
    $('[data-testid*="price" i], [data-component*="Price" i], [class*="price" i]').each((_, el) => {
      if (price) return;
      const t = $(el).text().trim();
      if (t && t.length < 60 && /[£$€₽]\s?\d|\d[\s.,]?\d{2,3}\s?[£$€₽]/.test(t)) price = t;
    });
  }
  // Отрезаем текст после цены (например "£338Import duties included" → "£338")
  if (price) {
    const m = price.match(/[£$€₽]\s?[\d\s.,]+|\d[\d\s.,]*\s?[£$€₽]/);
    if (m) price = m[0].trim();
  }

  // Детект страниц-блокировок антибота — не отдаём их как валидный результат
  const blockPatterns = /^(access denied|forbidden|attention required|just a moment|are you a robot|error \d{3}|flomni|похоже,? нет соединения|нет соединения с интернетом)/i;
  if (title && blockPatterns.test(title.trim())) {
    return { title: null, price: null, image: null };
  }

  return { title, price, image };
}

function mergeParseResults(a, b) {
  if (!a && !b) return { title: null, price: null, image: null };
  if (!a) return b;
  if (!b) return a;
  return {
    title: a.title || b.title || null,
    price: a.price || b.price || null,
    image: a.image || b.image || null,
  };
}



async function parseHandler(req, res) {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL обязателен' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Некорректный URL' }); }

  const host = new URL(url).hostname;
  const t = timer();
  const withTiming = (obj) => ({ ...(obj || { title: null, price: null, image: null }), _ms: t.total(), _steps: t.steps() });

  // 12storeez — прямой fetch (статический HTML содержит og:title, og:image, JSON-LD с ценой)
  if (host.includes('12storeez')) {
    try {
      const resp = await fetch(url, { headers: FETCH_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(10000) });
      const html = await resp.text();
      console.log(`[12storeez] direct fetch status=${resp.status} html_len=${html.length} url=${resp.url}`);
      const result = parseProductFromHtml(html, url);
      t.mark('12storeez:direct-fetch', { title: !!result?.title, price: !!result?.price, image: !!result?.image, status: resp.status });
      // Чистим название: убираем всё после первой запятой (цвет, категория, магазин)
      if (result?.title) result.title = result.title.split(',')[0].trim();
      if (result.title || result.price || result.image) {
        return res.json(withTiming(result));
      }
    } catch (e) {
      t.mark('12storeez:direct-fetch:error', { err: e.message });
    }
    // Fallback: Firecrawl если прямой fetch не сработал
    const fc = await parseViaFirecrawl(url);
    t.mark('12storeez:firecrawl', { title: !!fc?.title, price: !!fc?.price, image: !!fc?.image });
    if (fc?.title) fc.title = fc.title.split(',')[0].trim();
    return res.json(withTiming(fc));
  }

  // Wildberries — CDN API, без антибота
  if (host.includes('wildberries')) {
    const result = await parseWildberries(url);
    t.mark('wildberries:done', {
      title: !!result?.title, price: !!result?.price, image: !!result?.image,
      price_source: result?._wb_price_source || 'unknown',
      from_firecrawl: !!result?._wb_from_firecrawl,
    });
    const clean = { title: result?.title||null, price: result?.price||null, image: result?.image||null };
    if (result?._wb_from_firecrawl) t.mark('wildberries:firecrawl_fallback', {});
    return res.json(withTiming(clean));
  }

  // Ozon — прямой fetch + API + Playwright + Firecrawl
  if (host.includes('ozon.ru')) {
    const result = await parseOzon(url);
    const ozonMeta = { title: !!result?.title, price: !!result?.price, image: !!result?.image };
    if (result?._ozon_steps) ozonMeta.ozon_steps = result._ozon_steps;
    t.mark('ozon:done', ozonMeta);
    const clean = { title: result?.title || null, price: result?.price || null, image: result?.image || null };
    return res.json(withTiming(clean));
  }

  const accumulated = await parseByStrategy(url, host, t);
  t.mark('done');
  console.log(`[parse] ${host} за ${t.total()}ms:`, accumulated, t.steps());
  res.json(withTiming(accumulated));
}

// Кэш результатов парсинга (в памяти) + дедупликация одновременных запросов по одному URL.
const PARSE_CACHE = new Map();      // url -> { at, data }
const PARSE_INFLIGHT = new Map();   // url -> Promise
const PARSE_CACHE_TTL = 60 * 60 * 1000;

function runParse(url) {
  const hit = PARSE_CACHE.get(url);
  if (hit && Date.now() - hit.at < PARSE_CACHE_TTL) return Promise.resolve({ ...hit.data, _cached: true });
  if (PARSE_INFLIGHT.has(url)) return PARSE_INFLIGHT.get(url);
  const p = new Promise((resolve) => {
    const fakeRes = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ ...o, _status: this.statusCode }); return this; } };
    parseHandler({ body: { url } }, fakeRes).catch(e => resolve({ error: e.message, _status: 500 }));
  }).then(r => {
    if (r._status === 200 && (r.title || r.price || r.image)) {
      // неполный результат (нет цены) держим недолго — повторная попытка может дать больше
      const ttl = (r.title && r.price) ? PARSE_CACHE_TTL : 2 * 60 * 1000;
      PARSE_CACHE.set(url, { at: Date.now() - (PARSE_CACHE_TTL - ttl), data: r });
      if (PARSE_CACHE.size > 500) PARSE_CACHE.delete(PARSE_CACHE.keys().next().value);
    }
    return r;
  }).finally(() => PARSE_INFLIGHT.delete(url));
  PARSE_INFLIGHT.set(url, p);
  return p;
}

app.post('/parse', optionalAuth, async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL обязателен' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Некорректный URL' }); }
  const r = await runParse(url);
  const { _status, ...body } = r;
  res.status(_status || 200).json(body);
});

// Фоновое дополнение товара вишлиста: заполняем только пустые поля.
// ── Прокси картинок вишлиста: только URL, уже сохранённые в вишлисте (не открытый прокси) ──
const _dns = require('dns').promises;
const _net = require('net');
function _privIp(ip) {
  if (_net.isIPv6(ip)) return /^(::1|fc|fd|fe80)/i.test(ip) || ip === '::';
  const p = ip.split('.').map(Number);
  return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}
app.get('/img', async (req, res) => {
  try {
    const u = String(req.query.u || '');
    if (!/^https?:\/\//i.test(u) || u.length > 2000) return res.status(400).end();
    const known = await pool.query('SELECT 1 FROM wishlist WHERE image=$1 UNION ALL SELECT 1 FROM items WHERE image=$1 LIMIT 1', [u]);
    if (!known.rowCount) return res.status(404).end();
    const host = new URL(u).hostname;
    const addrs = await _dns.lookup(host, { all: true });
    if (!addrs.length || addrs.some(a => _privIp(a.address))) return res.status(403).end();
    const r = await fetch(u, {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', 'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8' },
      signal: AbortSignal.timeout(15000), redirect: 'follow'
    });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !/^image\//i.test(ct)) return res.status(502).end();
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 10 * 1024 * 1024) return res.status(413).end();
    res.set({ 'Content-Type': ct, 'Cache-Control': 'public, max-age=604800' });
    res.send(buf);
  } catch (e) { res.status(502).end(); }
});

// Загрузка своих фото (вещь, «я в этой вещи»): тело — сама картинка (image/jpeg|png|webp), до 8 МБ.
// Храним рядом с картинками из Telegram и отдаём через /media/:token.
app.post('/photos', authenticateToken, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '8mb' }), async (req, res) => {
  try {
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (!Buffer.isBuffer(req.body) || !req.body.length || !['image/jpeg', 'image/png', 'image/webp'].includes(mime))
      return res.status(400).json({ error: 'Нужна картинка JPEG, PNG или WebP' });
    const token = crypto.randomBytes(16).toString('hex');
    await pool.query('INSERT INTO tg_media (token, user_id, mime, data) VALUES ($1,$2,$3,$4)', [token, req.user.id, mime, req.body]);
    const base = PUBLIC_BASE || (req.protocol + '://' + req.get('host'));
    res.json({ url: `${base}/media/${token}` });
  } catch (e) { console.error('[photos]', e.message); res.status(500).json({ error: 'Не удалось сохранить фото' }); }
});

// Курсы валют ЦБ РФ для пересчёта цен вишлиста в рубли (кэш 6 часов)
let _rates = null, _ratesAt = 0;
app.get('/rates', async (req, res) => {
  try {
    if (!_rates || Date.now() - _ratesAt > 6 * 3600 * 1000) {
      const r = await fetch('https://www.cbr-xml-daily.ru/daily_json.js', { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('cbr ' + r.status);
      const j = await r.json();
      const rub = { RUB: 1 };
      for (const [code, v] of Object.entries(j.Valute || {})) rub[code] = v.Value / v.Nominal;
      _rates = { date: j.Date, rub }; _ratesAt = Date.now();
    }
    res.set('Cache-Control', 'public, max-age=3600').json(_rates);
  } catch (e) {
    if (_rates) return res.json(_rates);
    res.status(502).json({ error: 'Курсы недоступны' });
  }
});

// Картинки из постов Telegram (сохранены ботом). Токен случайный, 32 hex-символа.
app.get('/media/:token', async (req, res) => {
  try {
    if (!/^[0-9a-f]{32}$/.test(req.params.token)) return res.status(404).end();
    const r = await pool.query('SELECT mime, data FROM tg_media WHERE token=$1', [req.params.token]);
    if (!r.rows[0]) return res.status(404).end();
    res.set({ 'Content-Type': r.rows[0].mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.send(r.rows[0].data);
  } catch (e) { res.status(500).end(); }
});

async function enrichWishlistItem(id, userId, url, fallbackTitle) {
  try {
    await pool.query('UPDATE wishlist SET parse_attempts=COALESCE(parse_attempts,0)+1 WHERE id=$1', [id]);
    const m = await runParse(url);
    const cur = (await pool.query('SELECT title, price, image FROM wishlist WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
    if (!cur) return null; // удалили, пока парсили
    const titleEmpty = !cur.title || cur.title === fallbackTitle;
    const newTitle = titleEmpty && m.title ? m.title : cur.title;
    await pool.query(
      `UPDATE wishlist SET title=$1, price=COALESCE(NULLIF(price,''),$2), image=COALESCE(NULLIF(image,''),$3), parse_status=$4 WHERE id=$5 AND user_id=$6`,
      [titleEmpty && m.title ? m.title : cur.title, m.price || null, m.image || null,
       (m.title || m.price || m.image) ? 'done' : 'failed', id, userId]
    );
    return { title: newTitle, price: cur.price || m.price || null, image: cur.image || m.image || null, found: !!(m.title || m.price || m.image) };
  } catch (e) {
    console.error('[enrich]', e.message);
    try { await pool.query("UPDATE wishlist SET parse_status='failed' WHERE id=$1 AND parse_status='pending'", [id]); } catch (_) {}
    return null;
  }
}

// ── Повторное дополнение: Ozon/WB иногда не отдают данные с первого раза (антибот,
// перезапуск сервиса). Раз в 5 минут добираем пустые название/цену у свежих вещей
// и сообщаем в Telegram, если вещь добавляли через бота.
const RETRY_HOSTS_RE = /(ozon\.ru|wildberries\.ru|wb\.ru)/i;
async function retryWishlistEnrichment() {
  try {
    const r = await pool.query(
      `SELECT w.id, w.user_id, w.url, w.shop, w.title, w.price, u.tg_chat_id
         FROM wishlist w JOIN users u ON u.id = w.user_id
        WHERE w.url ~* '(ozon\.ru|wildberries\.ru|wb\.ru)'
          AND (w.parse_status = 'failed' OR w.price IS NULL OR w.price = '' OR w.title = w.shop)
          AND COALESCE(w.parse_attempts, 0) < 4
          AND COALESCE(w.added_at, NOW()) > NOW() - INTERVAL '3 days'
          AND w.received_at IS NULL
        ORDER BY w.id DESC LIMIT 5`);
    for (const w of r.rows) {
      if (!RETRY_HOSTS_RE.test(w.url || '')) continue;
      const hadPrice = !!w.price, hadTitle = w.title && w.title !== w.shop;
      const e = await enrichWishlistItem(w.id, w.user_id, w.url, w.shop);
      if (!e || !e.found) continue;
      const gained = (!hadPrice && e.price) || (!hadTitle && e.title && e.title !== w.shop);
      console.log(`[retry] wishlist ${w.id}: ${gained ? 'дополнено' : 'без изменений'}`);
      if (gained && w.tg_chat_id) {
        await tgSendItem(w.tg_chat_id, e, w.id, '✓ Подтянул: ');
      }
    }
  } catch (e) { console.error('[retry]', e.message); }
}
setTimeout(() => { retryWishlistEnrichment(); setInterval(retryWishlistEnrichment, 5 * 60 * 1000); }, 60 * 1000);











// ── PROBE: Спортмастер через РФ-прокси ──────────────────────────────────────
app.get('/debug/smproxy', async (req, res) => {
  const pid = req.query.pid || '37250110299';
  const sku = req.query.sku || '83264660299';
  const pageUrl = `https://www.sportmaster.ru/product/${pid}/?skuId=${sku}`;
  const v = String(req.query.v || '1');
  const t0 = Date.now();
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  try {
    // v1: ruFetch (Timeweb РФ-прокси) прямо на страницу товара
    if (v === '1') {
      const r = await ruFetch(pageUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                   'Accept-Language': 'ru-RU,ru;q=0.9', 'Referer': 'https://www.sportmaster.ru/' },
        signal: AbortSignal.timeout(20000),
      });
      const txt = await r.text();
      const p = parseProductFromHtml(txt, pageUrl);
      const m = txt.match(/(\d[\d\s\u00a0]{2,9})\s*(?:₽|руб)/);
      return res.json({ variant: 'ruFetch_proxy', status: r.status, ms: Date.now() - t0, len: txt.length,
        title: p.title && p.title.slice(0, 60), price: p.price, image: !!p.image,
        price_regex: m ? m[1].replace(/[\s\u00a0]/g, '') + ' RUB' : null,
        head: p.title ? undefined : txt.slice(0, 200) });
    }

    // v2: cookie-цепочка через РФ-прокси (главная → товар)
    if (v === '2') {
      const r = await fetchWithCookies(pageUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml',
                   'Accept-Language': 'ru-RU,ru;q=0.9' },
        signal: AbortSignal.timeout(25000),
      }, 20);
      const txt = await r.text();
      const p = parseProductFromHtml(txt, pageUrl);
      const m = txt.match(/(\d[\d\s\u00a0]{2,9})\s*(?:₽|руб)/);
      return res.json({ variant: 'cookies_via_proxy', status: r.status, ms: Date.now() - t0, len: txt.length,
        title: p.title && p.title.slice(0, 60), price: p.price, image: !!p.image,
        price_regex: m ? m[1].replace(/[\s\u00a0]/g, '') + ' RUB' : null,
        head: p.title ? undefined : txt.slice(0, 200) });
    }

    // v3: Playwright через РФ-прокси — настоящий браузер + российский IP
    const browser = await getHeadlessBrowser();
    const proxyCfg = getPlaywrightProxyConfig();
    const ctx = await browser.newContext(Object.assign({
      userAgent: UA, viewport: { width: 1440, height: 900 }, locale: 'ru-RU',
      extraHTTPHeaders: { 'Accept-Language': 'ru-RU,ru;q=0.9' },
    }, proxyCfg ? { proxy: proxyCfg } : {}));
    const page = await ctx.newPage();
    await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
    let navStatus = null;
    try {
      const resp = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      navStatus = resp && resp.status();
    } catch (_) {}
    await page.waitForTimeout(7000);
    const data = await page.evaluate(() => {
      const og = k => { const el = document.querySelector(`meta[property="${k}"]`); return el && el.content; };
      let price = null;
      for (const sel of ['[itemprop="price"]', '[data-test*="price"]', '[class*="price"]']) {
        const el = document.querySelector(sel);
        if (el) { price = (el.getAttribute('content') || el.textContent || '').trim().slice(0, 40); if (price) break; }
      }
      return { title: document.title, og_title: og('og:title'), og_image: !!og('og:image'), price,
               body: document.body ? document.body.innerText.slice(0, 200) : '' };
    });
    await ctx.close();
    res.json({ variant: 'playwright_ru_proxy', ms: Date.now() - t0, navStatus, proxyUsed: !!proxyCfg, ...data });
  } catch (err) {
    res.json({ v, error: err.message.slice(0, 100), ms: Date.now() - t0 });
  }
});

// ── PROBE: Спортмастер — обход 401 ──────────────────────────────────────────
app.get('/debug/smprobe', async (req, res) => {
  const productId = req.query.pid || '37250110299';
  const skuId = req.query.sku || '83264660299';
  const pageUrl = `https://www.sportmaster.ru/product/${productId}/?skuId=${skuId}`;
  const v = String(req.query.v || '1');
  const t0 = Date.now();
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  function summarize(txt, label, status) {
    const e = { variant: label, status, ms: Date.now() - t0, len: txt.length };
    if (txt.trim().startsWith('{') || txt.trim().startsWith('[')) {
      try {
        const d = JSON.parse(txt);
        e.json_keys = Object.keys(d).slice(0, 15).join(',');
        e.sample = JSON.stringify(d).slice(0, 400);
      } catch (_) { e.head = txt.slice(0, 200); }
    } else {
      const p = parseProductFromHtml(txt, pageUrl);
      e.title = p.title ? p.title.slice(0, 60) : null;
      e.price = p.price;
      e.image = !!p.image;
      const m = txt.match(/(\d[\d\s\u00a0]{2,9})\s*(?:₽|руб)/);
      e.price_regex = m ? m[1].replace(/[\s\u00a0]/g, '') + ' RUB' : null;
      if (!e.title) e.head = txt.slice(0, 200);
    }
    return e;
  }

  try {
    // v1: cookie-цепочка — сначала главная, потом товар с накопленными куками
    if (v === '1') {
      const home = await fetch('https://www.sportmaster.ru/', {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'ru-RU,ru;q=0.9' },
        signal: AbortSignal.timeout(15000),
      });
      const raw = home.headers.getSetCookie ? home.headers.getSetCookie() : [];
      const cookie = raw.map(s => s.split(';')[0]).join('; ');
      const r = await fetch(pageUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'ru-RU,ru;q=0.9',
                   'Referer': 'https://www.sportmaster.ru/', Cookie: cookie },
        signal: AbortSignal.timeout(15000),
      });
      const txt = await r.text();
      const e = summarize(txt, 'cookie_chain', r.status);
      e.home_status = home.status;
      e.cookies_got = raw.length;
      return res.json(e);
    }

    // v2: AJAX-заголовки
    if (v === '2') {
      const r = await fetch(pageUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
                   'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://www.sportmaster.ru/',
                   'Accept-Language': 'ru-RU,ru;q=0.9', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin' },
        signal: AbortSignal.timeout(15000),
      });
      return res.json(summarize(await r.text(), 'ajax_headers', r.status));
    }

    // v3: внутренние API-эндпоинты
    if (v === '3') {
      const candidates = [
        `https://www.sportmaster.ru/product/api/product/${productId}`,
        `https://www.sportmaster.ru/api/product/${productId}`,
        `https://www.sportmaster.ru/product/${productId}/api/`,
        `https://www.sportmaster.ru/api/v1/product/${productId}`,
        `https://www.sportmaster.ru/catalogapi/product/${productId}`,
      ];
      const results = {};
      for (const u of candidates) {
        try {
          const r = await fetch(u, {
            headers: { 'User-Agent': UA, Accept: 'application/json', 'Referer': pageUrl,
                       'X-Requested-With': 'XMLHttpRequest' },
            signal: AbortSignal.timeout(8000),
          });
          const txt = await r.text();
          results[u.replace('https://www.sportmaster.ru', '')] = {
            status: r.status, len: txt.length, head: txt.slice(0, 120),
          };
        } catch (e) { results[u.replace('https://www.sportmaster.ru', '')] = { error: e.message.slice(0, 50) }; }
      }
      return res.json({ variant: 'api_endpoints', ms: Date.now() - t0, results });
    }

    // v4: Playwright — реальный браузер, ждём рендер цены
    if (v === '4') {
      const browser = await getHeadlessBrowser();
      const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 },
        locale: 'ru-RU', extraHTTPHeaders: { 'Accept-Language': 'ru-RU,ru;q=0.9' } });
      const page = await ctx.newPage();
      await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
      let navStatus = null;
      try {
        const resp = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        navStatus = resp && resp.status();
      } catch (_) {}
      await page.waitForTimeout(6000);
      const data = await page.evaluate(() => {
        const og = k => { const el = document.querySelector(`meta[property="${k}"]`); return el && el.content; };
        const bodyText = document.body ? document.body.innerText.slice(0, 300) : '';
        let price = null;
        const sel = document.querySelector('[class*="price"],[data-test*="price"],[itemprop="price"]');
        if (sel) price = (sel.getAttribute('content') || sel.textContent || '').trim().slice(0, 40);
        return { title: document.title, og_title: og('og:title'), og_image: og('og:image'), price, bodyText };
      });
      await ctx.close();
      return res.json({ variant: 'playwright_deep', ms: Date.now() - t0, navStatus, ...data });
    }

    // v5: Firecrawl с actions (ожидание + скролл)
    const apiKey = process.env.FIRECRAWL_API_KEY;
    const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: pageUrl, formats: ['html'], onlyMainContent: false, timeout: 50000,
        location: { country: 'RU' },
        actions: [{ type: 'wait', milliseconds: 5000 }, { type: 'scroll', direction: 'down' }, { type: 'wait', milliseconds: 4000 }],
      }),
      signal: AbortSignal.timeout(75000),
    });
    const e = { variant: 'fc_actions', http: r.status, ms: Date.now() - t0 };
    if (!r.ok) { e.body = (await r.text()).slice(0, 200); return res.json(e); }
    const d = await r.json();
    const html = d.data && d.data.html;
    const meta = (d.data && d.data.metadata) || {};
    e.meta_status = meta.statusCode;
    e.meta_title = meta.title && String(meta.title).slice(0, 50);
    e.html_len = html ? html.length : 0;
    if (html) {
      const p = parseProductFromHtml(html, pageUrl);
      e.title = p.title && p.title.slice(0, 60);
      e.price = p.price;
      e.image = !!p.image;
      const m = html.match(/(\d[\d\s\u00a0]{2,9})\s*(?:₽|руб)/);
      e.price_regex = m ? m[1].replace(/[\s\u00a0]/g, '') + ' RUB' : null;
    }
    res.json(e);
  } catch (err) {
    res.json({ v, error: err.message.slice(0, 100), ms: Date.now() - t0 });
  }
});

// ── PROBE: универсальный тест вариантов Firecrawl для любого URL ────────────
app.get('/debug/fcprobe', async (req, res) => {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return res.json({ error: 'no FIRECRAWL_API_KEY' });
  const url = req.query.url;
  if (!url) return res.json({ error: 'url required' });
  const v = String(req.query.v || '0');

  const variants = {
    '0': { label: 'direct_fetch', direct: true },
    '1': { label: 'fc_plain',     body: { waitFor: 5000 } },
    '2': { label: 'fc_loc_ru',    body: { waitFor: 6000, location: { country: 'RU' } } },
    '3': { label: 'fc_stealth_ru',body: { waitFor: 8000, proxy: 'stealth', location: { country: 'RU' } } },
    '4': { label: 'playwright',   playwright: true },
  };
  const variant = variants[v] || variants['1'];
  const t0 = Date.now();

  try {
    if (variant.direct) {
      const r = await fetch(url, { headers: FETCH_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      const html = await r.text();
      const p = parseProductFromHtml(html, url);
      const m = html.match(/(\d[\d\s\u00a0]{2,9})\s*(?:₽|руб)/);
      return res.json({ variant: variant.label, status: r.status, ms: Date.now() - t0, html_len: html.length,
        title: p.title && p.title.slice(0, 60), price: p.price, image: !!p.image,
        price_regex: m ? m[1].replace(/[\s\u00a0]/g, '') + ' RUB' : null });
    }

    if (variant.playwright) {
      const p = await parseViaPlaywright(url, 'ru-RU', false);
      return res.json({ variant: variant.label, ms: Date.now() - t0,
        title: p && p.title && p.title.slice(0, 60), price: p && p.price, image: !!(p && p.image) });
    }

    const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ url, formats: ['html'], onlyMainContent: false, timeout: 45000 }, variant.body)),
      signal: AbortSignal.timeout(70000),
    });
    const e = { variant: variant.label, http: r.status, ms: Date.now() - t0 };
    if (!r.ok) { e.body = (await r.text()).slice(0, 180); return res.json(e); }
    const d = await r.json();
    const html = d.data && d.data.html;
    const meta = (d.data && d.data.metadata) || {};
    e.html_len = html ? html.length : 0;
    e.meta_title = meta.title ? String(meta.title).slice(0, 60) : null;
    e.meta_status = meta.statusCode;
    if (html) {
      const p = parseProductFromHtml(html, url);
      e.title = p.title ? p.title.slice(0, 60) : null;
      e.price = p.price;
      e.image = !!p.image;
      const m = html.match(/(\d[\d\s\u00a0]{2,9})\s*(?:₽|руб)/);
      e.price_regex = m ? m[1].replace(/[\s\u00a0]/g, '') + ' RUB' : null;
    }
    res.json(e);
  } catch (err) {
    res.json({ variant: variant.label, error: err.message.slice(0, 90), ms: Date.now() - t0 });
  }
});

// ── DEBUG: замеры скорости Firecrawl с произвольными параметрами (временно) ──
// /debug/fcspeed?url=...&wf=0&loc=RU&fmt=rawHtml&maxAge=0&raw=1&actions=none
app.get('/debug/fcspeed', async (req, res) => {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return res.json({ error: 'no FIRECRAWL_API_KEY' });
  const url = req.query.url;
  if (!url) return res.json({ error: 'url required' });
  const body = { url, formats: [req.query.fmt || 'rawHtml'], onlyMainContent: false, timeout: Number(req.query.timeout) || 30000 };
  if (req.query.wf !== undefined) body.waitFor = Number(req.query.wf);
  if (req.query.loc) body.location = { country: req.query.loc };
  if (req.query.maxAge !== undefined) body.maxAge = Number(req.query.maxAge);
  if (req.query.proxy) body.proxy = req.query.proxy;
  const t0 = Date.now();
  try {
    const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const e = { sent: { ...body, url: undefined }, http: r.status, ms: Date.now() - t0 };
    const txt = await r.text();
    let d = null; try { d = JSON.parse(txt); } catch (_) {}
    if (!d) { e.body = txt.slice(0, 200); return res.json(e); }
    if (!d.success) { e.err = JSON.stringify(d).slice(0, 200); return res.json(e); }
    const html = d.data && (d.data.rawHtml || d.data.html);
    const meta = d.data.metadata || {};
    e.html_len = html ? html.length : 0;
    e.meta_status = meta.statusCode; e.meta_title = meta.title ? String(meta.title).slice(0, 60) : null;
    e.cache = meta.cacheState || null;
    if (html) {
      const p = parseProductFromHtml(html, url);
      e.title = p.title ? p.title.slice(0, 60) : null; e.price = p.price; e.image = !!p.image;
      if (req.query.raw === '1') e.raw = html.slice(0, 700);
    }
    res.json(e);
  } catch (err) { res.json({ error: err.message.slice(0, 120), ms: Date.now() - t0 }); }
});

// Scrape.do — провайдер скрейпинга (параметры: render, super, geo, wait)
async function fetchViaScrapedo(url, o = {}) {
  const token = process.env.SCRAPEDO_TOKEN;
  if (!token) return { error: 'no SCRAPEDO_TOKEN' };
  const p = new URLSearchParams({ token, url });
  if (o.render) p.set('render', 'true');
  if (o.super) p.set('super', 'true');
  if (o.geo) p.set('geoCode', o.geo);
  if (o.wait) { p.set('waitUntil', 'networkidle2'); }
  if (o.customWait) p.set('customWait', String(o.customWait));
  const t0 = Date.now();
  try {
    const r = await fetch('https://api.scrape.do/?' + p.toString(), { signal: AbortSignal.timeout(o.timeout || 60000) });
    const html = await r.text();
    return { http: r.status, ms: Date.now() - t0, html, cost: r.headers.get('scrape.do-request-cost'), remaining: r.headers.get('scrape.do-remaining-credits') };
  } catch (e) { return { error: e.message.slice(0, 120), ms: Date.now() - t0 }; }
}

app.get('/debug/sdprobe', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.json({ error: 'url required' });
  const r = await fetchViaScrapedo(url, {
    render: req.query.render === '1', super: req.query.super === '1', geo: req.query.geo || null,
    wait: req.query.wait === '1', customWait: Number(req.query.cw) || 0,
  });
  const e = { http: r.http, ms: r.ms, cost: r.cost, remaining: r.remaining, error: r.error };
  if (r.html) {
    e.html_len = r.html.length;
    const p = parseProductFromHtml(r.html, url);
    e.title = p.title ? p.title.slice(0, 60) : null; e.price = p.price; e.image = !!p.image;
    if (!p.title && !p.price) e.head = r.html.slice(0, 160).replace(/\s+/g, ' ');
  }
  res.json(e);
});

// ВРЕМЕННО: что лежит в вишлисте у пользователей, подключивших Telegram (только поля отображения)
// /debug/uaprobe?url=...&ua=chrome|tg|fb|google|wa — прямой fetch с Railway-IP под разными User-Agent
app.get('/debug/uaprobe', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.json({ error: 'url required' });
  const UAS = {
    chrome: FETCH_HEADERS['User-Agent'],
    tg: 'TelegramBot (like TwitterBot)',
    fb: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    google: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    wa: 'WhatsApp/2.23.20.0 A',
    tw: 'Twitterbot/1.0',
    slack: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  };
  const ua = String(req.query.ua || 'chrome');
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { ...FETCH_HEADERS, 'User-Agent': UAS[ua] || UAS.chrome }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
    const html = await r.text();
    const p = parseProductFromHtml(html, url);
    res.json({ ua, status: r.status, ms: Date.now() - t0, html_len: html.length,
      json_ld: /application\/ld\+json/.test(html), og_title: /property=["']og:title/.test(html),
      title: p.title ? p.title.slice(0, 70) : null, price: p.price, image: !!p.image });
  } catch (err) { res.json({ ua, error: err.message.slice(0, 100), ms: Date.now() - t0 }); }
});

// ── DEBUG: диагностика прокси ────────────────────────────────────────────────
app.get('/debug/proxy-check', async (req, res) => {
  const result = {
    RU_PROXY_URL_set: !!process.env.RU_PROXY_URL,
    RU_PROXY_URL_preview: process.env.RU_PROXY_URL
      ? process.env.RU_PROXY_URL.replace(/:([^@]+)@/, ':***@')  // скрываем пароль
      : null,
    ruProxyAgent_created: !!ruProxyAgent,
    tests: {}
  };

  // Тест 1: что видит внешний мир как наш IP (без прокси)
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
    result.tests.direct_ip = (await r.json()).ip;
  } catch(e) { result.tests.direct_ip_error = e.message; }

  // Тест 2: IP через прокси + его ASN (чтобы понять провайдера)
  if (ruProxyAgent) {
    try {
      const r = await ruFetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(8000) });
      const ip = (await r.json()).ip;
      result.tests.proxy_ip = ip;
      result.tests.proxy_works = true;
      // Получаем ASN
      try {
        const asnR = await ruFetch(`https://ipapi.co/${ip}/json/`, { signal: AbortSignal.timeout(5000) });
        const asnD = await asnR.json();
        result.tests.proxy_asn = asnD.asn;
        result.tests.proxy_org = asnD.org;
        result.tests.proxy_city = asnD.city;
      } catch(_) {}
    } catch(e) {
      result.tests.proxy_ip_error = e.message;
      result.tests.proxy_works = false;
    }
  }

  // Тест 3: WB цена через card.wb.ru (не геоблокирован) и search.wb.ru через прокси
  const WB_NM = '1510075000';
  try {
    // card.wb.ru — без прокси
    const cr = await fetch(`https://card.wb.ru/cards/v1/detail?appType=1&curr=rub&dest=-1257786&nm=${WB_NM}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', Referer: 'https://www.wildberries.ru/' },
        signal: AbortSignal.timeout(6000) });
    result.tests.wb_card_status = cr.status;
    if (cr.ok) {
      const cd = await cr.json();
      const prod = cd?.data?.products?.find(p => String(p.id) === WB_NM);
      result.tests.wb_card_found = !!prod;
      if (prod) {
        result.tests.wb_card_keys = Object.keys(prod).slice(0,15).join(',');
        const sizes = prod?.sizes || [];
        result.tests.wb_card_sizes0_price = JSON.stringify(sizes[0]?.price);
        result.tests.wb_card_salePriceU = prod?.salePriceU;
        result.tests.wb_card_priceU = prod?.priceU;
      }
    }
  } catch(e) { result.tests.wb_card_error = e.message; }

  // search.wb.ru через прокси — с правильным форматом
  if (ruProxyAgent) {
    try {
      const sr = await ruFetch(
        `https://search.wb.ru/exactmatch/ru/common/v7/search?appType=1&curr=rub&dest=-1257786&resultset=catalog&limit=1&nm=${WB_NM}`,
        { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', Referer: 'https://www.wildberries.ru/' },
          signal: AbortSignal.timeout(8000) });
      result.tests.wb_search_nm_status = sr.status;
      if (sr.ok) {
        const sd = await sr.json();
        const prod = sd?.data?.products?.find(p => String(p.id) === WB_NM);
        result.tests.wb_search_nm_found = !!prod;
        if (prod) {
          const kopecks = prod?.salePriceU ?? prod?.priceU ?? prod?.sizes?.[0]?.price?.total;
          result.tests.wb_search_nm_price = kopecks ? Math.round(kopecks/100) + ' ₽' : 'no price';
        }
      }
    } catch(e) { result.tests.wb_search_nm_error = e.message; }
  }

  // Тест 4: Ozon через прокси — несколько хостов
  if (ruProxyAgent) {
    for (const [label, url] of [
      ['ozon_main', 'https://www.ozon.ru/'],
      ['ozon_api', 'https://api.ozon.ru/composer-api.bx/page/json/v2?url=/'],
      ['ozon_cdn', 'https://cdn1.ozone.ru/'],
    ]) {
      try {
        const r = await ruFetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15', Accept: 'text/html,application/json' },
          signal: AbortSignal.timeout(6000)
        });
        result.tests[label] = r.status;
      } catch(e) { result.tests[label + '_error'] = e.message.slice(0,80); }
    }
  }

  res.json(result);
});

// ── HEALTHLOG (просмотр логов из чата) ───────────────────────────────────────
app.get('/healthlog', (req, res) => {
  const secret = process.env.LOG_SECRET;
  if (!secret) return res.status(403).json({ error: 'LOG_SECRET not configured' });
  if (req.query.secret !== secret) return res.status(403).json({ error: 'forbidden' });
  const n = parseInt(req.query.n) || 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(logBuffer.slice(-n).join('\n'));
});

// ── СТАТИКА ───────────────────────────────────────────────────────────────────
app.get('/proto', (req, res) => res.sendFile(__dirname + '/sizebook-proto.html'));
// Экспериментальный вид «паспорт-термоэтикетка»; основное приложение остаётся на «/»
app.get('/passport', (req, res) => res.sendFile(__dirname + '/passport.html'));
app.get('/s/:token', (req, res) => res.sendFile(__dirname + '/share.html'));
app.get('/', (req, res) => res.sendFile(__dirname + '/sizebook4.html'));

// ── СТАРТ ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => { console.log(`SizeBook on port ${PORT}`); tgSetWebhook(); });
}).catch(e => { console.error('DB init error:', e); process.exit(1); });
