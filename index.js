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
const JWT_SECRET = process.env.JWT_SECRET || 'sizebook-super-secret-2024';

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

  const usersCountRes = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  const usersCount = usersCountRes.rows[0].c;
  console.log(`[seed] users count at startup: ${usersCount}`);

  const adminCheck = await pool.query("SELECT id FROM users WHERE username='admin'");

  if (adminCheck.rows.length) {
    const adminId = adminCheck.rows[0].id;
    const hash = await bcrypt.hash('admin', 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, adminId]);
    console.log(`[seed] admin already existed with id=${adminId}, password forcibly reset to 'admin'`);
  } else if (usersCount === 0) {
    // Таблица пустая — обычный SERIAL INSERT даст id=1, это совпадёт
    // с user_id=1, который использовался в гостевом режиме для
    // существующих sizes/items/wishlist. НЕ указываем id явно.
    const hash = await bcrypt.hash('admin', 10);
    const r = await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES ('admin','admin@sizebook.local',$1) RETURNING id",
      [hash]
    );
    console.log(`[seed] created admin with id=${r.rows[0].id}`);
  } else {
    // В users уже есть строки, но это не admin — не угадываем, что делать
    // с привязкой существующих sizes/items/wishlist (user_id=1). Создаём
    // admin как нового пользователя, но НЕ трогаем существующие данные.
    const hash = await bcrypt.hash('admin', 10);
    const r = await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES ('admin','admin@sizebook.local',$1) RETURNING id",
      [hash]
    );
    console.log(`[seed] WARNING: users table was non-empty (count=${usersCount}) before seeding admin. ` +
                `Admin got id=${r.rows[0].id}, which may NOT match the legacy guest user_id=1 data. ` +
                `Manual review needed — check Railway logs and existing sizes/items/wishlist rows with user_id=1.`);
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

function authenticateToken(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) {
    // Авторизация отключена для тестирования — подставляем тестового пользователя
    req.user = { id: 1 };
    return next();
  }
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      // Невалидный токен — тоже считаем гостем, не блокируем
      req.user = { id: 1 };
      return next();
    }
    req.user = user;
    next();
  });
}

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
  const { title, shop, url, price, size, image } = req.body;
  if (!title) return res.status(400).json({ error: 'Нужно название' });
  try {
    const r = await pool.query(
      'INSERT INTO wishlist (user_id,title,shop,url,price,size,image) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [req.user.id, title, shop||null, url||null, price||null, size||null, image||null]
    );
    res.json(r.rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

app.delete('/wishlist/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM wishlist WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

// ── ПУБЛИЧНЫЙ ПРОФИЛЬ ─────────────────────────────────────────────────────────
app.get('/profile/:username', async (req, res) => {
  try {
    const ur = await pool.query('SELECT id,username FROM users WHERE username=$1', [req.params.username.toLowerCase()]);
    if (!ur.rows.length) return res.status(404).json({ error: 'Не найден' });
    const u = ur.rows[0];
    const wr = await pool.query('SELECT * FROM wishlist WHERE user_id=$1 ORDER BY id DESC', [u.id]);
    const sr = await pool.query('SELECT data FROM sizes WHERE user_id=$1', [u.id]);
    res.json({ username: u.username, wishlist: wr.rows, sizes: sr.rows[0]?.data || {} });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

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
    }

    if (sections.wishlist) {
      const wr = await pool.query(
        'SELECT * FROM wishlist WHERE user_id=$1 ORDER BY id DESC', [link.user_id]
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
app.get('/items', authenticateToken, async (req, res) => {
  try {
    const zone = req.query.zone;
    if (!zone) return res.status(400).json({ error: 'zone required' });
    const r = await pool.query(
      'SELECT * FROM items WHERE user_id=$1 AND zone=$2 ORDER BY id ASC',
      [req.user.id, zone]
    );
    res.json(r.rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

app.post('/items', authenticateToken, async (req, res) => {
  try {
    const { zone, name, brand, size, note } = req.body;
    if (!zone || !name) return res.status(400).json({ error: 'zone и name обязательны' });
    const r = await pool.query(
      'INSERT INTO items (user_id, zone, name, brand, size, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user.id, zone, name, brand || null, size || null, note || null]
    );
    res.json(r.rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

app.delete('/items/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM items WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
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
    const pricePromise = parseViaFirecrawl(url, { waitFor: 6000, country: 'RU' })
      .then(fc => (fc && fc.price) || null)
      .catch(e => { console.log(`[wb] Firecrawl(RU) ошибка: ${e.message}`); return null; });

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
      const fc = await parseViaFirecrawl(url, { waitFor: 6000, country: 'RU' });
      return { title: fc?.title || null, price: fc?.price || (await pricePromise) || null, image: fc?.image || null, _wb_from_firecrawl: true, _wb_price_source: 'firecrawl_ru' };
    }
    console.log(`[wb] нашли basket-${foundBasket}, ключи:`, Object.keys(card).slice(0, 8));
    const base = `https://basket-${foundBasket}.wbbasket.ru/vol${vol}/part${part}/${nm}`;
    const title = card.imt_name || card.name || null;
    const image = `${base}/images/big/1.webp`;

    if (!title) {
      console.log(`[wb] imt_name пустой, пробуем Firecrawl для title`);
      const fc = await parseViaFirecrawl(url);
      return { title: fc?.title || null, price: fc?.price || null, image };
    }

    // ── ЦЕНА WB ──────────────────────────────────────────────────────────
    // Прямые API недоступны: card.wb.ru отдаёт 403 с любого IP, search.wb.ru —
    // постоянный 429 с датацентровых IP (проверено: proxy6.net и Timeweb).
    // Рабочий путь: Firecrawl с location.country='RU' рендерит страницу товара
    // с российского резидентного IP — цена присутствует в HTML.
    const price = await pricePromise;
    const priceSource = price ? 'firecrawl_ru' : 'none';
    console.log(`[wb] цена: ${price || 'не найдена'} (${priceSource})`);

    return { title, price, image, _wb_price_source: priceSource };
  } catch (e) {
    console.log(`[wb] parseWildberries ошибка: ${e.message}`);
    return null;
  }
}

// Ozon — прямой fetch (Ozon отдаёт JSON-LD и og-теги в статическом HTML)
async function parseOzon(url) {
  // Ozon закрыт для автоматического парсинга. Проверено (см. probe-сессию):
  //   - прямой fetch / cookie-цепочка → 403 после антибот-редиректа __rr=1
  //   - composer-api / entrypoint-api, домены .ru/.by/.kz → то же самое
  //   - Playwright с РФ-прокси и без → пустая страница
  //   - Firecrawl: plain / location:RU / proxy:stealth (waitFor до 25s)
  //     → страница "Antibot Captcha", HTTP 403
  // Единственный оставшийся путь — внешний сервис с решением капчи (платный).
  // Пока его нет, возвращаемся сразу: тратить 8-20 секунд на заведомо
  // безуспешный каскад хуже, чем честно отдать пустой результат.
  console.log('[ozon] пропущен: требуется обход капчи, см. комментарий в parseOzon');
  return {
    title: null, price: null, image: null,
    _ozon_steps: [{ step: 'skipped', reason: 'antibot_captcha_requires_solver' }],
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



app.post('/parse', authenticateToken, async (req, res) => {
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

  const BOT_PROTECTED = host.includes('net-a-porter') || host.includes('matchesfashion') || host.includes('farfetch') || host.includes('sportmaster');

  // Шаг a: прямой fetch + HTML-парсер
  let accumulated = { title: null, price: null, image: null };
  try {
    const response = await fetch(url, {
      headers: FETCH_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const html = await response.text();
    const direct = parseProductFromHtml(html, url);
    t.mark('direct-fetch', { title: !!direct.title, price: !!direct.price, image: !!direct.image });
    accumulated = mergeParseResults(accumulated, direct);

    // Для обычных сайтов — если что-то нашли, сразу отдаём
    if (!BOT_PROTECTED && (accumulated.title || accumulated.price || accumulated.image)) {
      return res.json(withTiming(accumulated));
    }
  } catch (e) {
    t.mark('direct-fetch:error', { err: e.message });
    if (e.name === 'TimeoutError' && !BOT_PROTECTED)
      return res.status(504).json({ error: 'Сайт не ответил', _ms: t.total(), _steps: t.steps() });
  }

  // Для обычных сайтов без результата — возвращаем null
  if (!BOT_PROTECTED) {
    return res.json(withTiming(accumulated));
  }

  // Шаг b: BOT_PROTECTED — пробуем Playwright (умеет price из JSON-LD/og:price/DOM).
  // Для Farfetch этот шаг по опыту всегда возвращает пусто (антибот на уровне
  // рендера через headless Chromium) — пропускаем его и экономим ~2.5 сек,
  // сразу переходя к Firecrawl, который реально справляется с Farfetch.
  const skipPlaywright = host.includes('farfetch');
  if (!skipPlaywright && (!accumulated.title || !accumulated.price)) {
    const playwright = await parseViaPlaywright(url);
    t.mark('playwright', { title: !!playwright?.title, price: !!playwright?.price, image: !!playwright?.image });
    accumulated = mergeParseResults(accumulated, playwright);
  } else if (skipPlaywright) {
    t.mark('playwright:skipped-known-dead-for-farfetch');
  }

  // Шаг c: Firecrawl — обходит антибот лучше Playwright, умеет и price
  if (!accumulated.title || !accumulated.price) {
    const firecrawl = await parseViaFirecrawl(url, { waitFor: host.includes('farfetch') ? 3000 : 4000 });
    t.mark('firecrawl', { title: !!firecrawl?.title, price: !!firecrawl?.price, image: !!firecrawl?.image });
    accumulated = mergeParseResults(accumulated, firecrawl);
  }

  // Шаг d: если всё ещё нет title или image — дополняем через внешние OG-парсеры
  // (они умеют title/image, но не price — поэтому идут последними)
  if (!accumulated.title || !accumulated.image) {
    const jsonlink = await parseViaJsonlink(url);
    t.mark('jsonlink', { title: !!jsonlink?.title, image: !!jsonlink?.image });
    accumulated = mergeParseResults(accumulated, jsonlink);

    if (!accumulated.title || !accumulated.image) {
      const iframely = await parseViaIframely(url);
      t.mark('iframely', { title: !!iframely?.title, image: !!iframely?.image });
      accumulated = mergeParseResults(accumulated, iframely);
    }
  }

  // Шаг e: отдаём что есть (price может быть null — это нормально, если ни один метод не нашёл)
  t.mark('done');
  console.log(`[parse] final result (${host}) за ${t.total()}ms:`, accumulated, t.steps());
  res.json(withTiming(accumulated));
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
app.get('/s/:token', (req, res) => res.sendFile(__dirname + '/share.html'));
app.get('/', (req, res) => res.sendFile(__dirname + '/sizebook4.html'));

// ── СТАРТ ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`SizeBook on port ${PORT}`));
}).catch(e => { console.error('DB init error:', e); process.exit(1); });
