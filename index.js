const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'sizebook-super-secret-2024';

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
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Токен недействителен' });
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

// ── SIZES ─────────────────────────────────────────────────────────────────────
app.get('/sizes', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM sizes WHERE user_id=$1', [req.user.id]);
    res.json(r.rows[0]?.data || {});
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/sizes', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO sizes (user_id, data) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET data=$2, updated_at=NOW()`,
      [req.user.id, JSON.stringify(req.body)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ── WISHLIST ──────────────────────────────────────────────────────────────────
app.get('/wishlist', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM wishlist WHERE user_id=$1 ORDER BY added_at DESC',
      [req.user.id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
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
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

app.delete('/wishlist/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM wishlist WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ── ПУБЛИЧНЫЙ ПРОФИЛЬ ─────────────────────────────────────────────────────────
app.get('/profile/:username', async (req, res) => {
  try {
    const ur = await pool.query('SELECT id,username FROM users WHERE username=$1', [req.params.username.toLowerCase()]);
    if (!ur.rows.length) return res.status(404).json({ error: 'Не найден' });
    const u = ur.rows[0];
    const wr = await pool.query('SELECT * FROM wishlist WHERE user_id=$1 ORDER BY added_at DESC', [u.id]);
    const sr = await pool.query('SELECT data FROM sizes WHERE user_id=$1', [u.id]);
    res.json({ username: u.username, wishlist: wr.rows, sizes: sr.rows[0]?.data || {} });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ── ПАРСЕР ────────────────────────────────────────────────────────────────────
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
  'Connection': 'keep-alive',
};

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

  // 4. Fallback — title страницы
  if (!title) title = $('title').text().trim().split('|')[0].split('-')[0].trim() || null;
  if (title?.length > 120) title = title.slice(0, 120).trim();

  return { title, price, image };
}

app.post('/parse', authenticateToken, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL обязателен' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Некорректный URL' }); }

  const host = new URL(url).hostname;

  // Сайты с Cloudflare — используем внешние парсеры
  if (host.includes('net-a-porter') || host.includes('matchesfashion')) {
    let result = await parseViaJsonlink(url);
    if (result?.title) return res.json(result);
    result = await parseViaIframely(url);
    if (result?.title) return res.json(result);
    // Если оба не сработали — возвращаем пустой результат (пользователь заполнит вручную)
    return res.json({ title: null, price: null, image: null });
  }

  // Универсальный HTML-парсер для всех остальных сайтов
  try {
    const response = await fetch(url, {
      headers: FETCH_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const html = await response.text();
    res.json(parseProductFromHtml(html, url));
  } catch (e) {
    if (e.name === 'TimeoutError') return res.status(504).json({ error: 'Сайт не ответил' });
    res.status(500).json({ error: 'Не удалось загрузить страницу' });
  }
});

// ── СТАТИКА ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(__dirname + '/sizebook4.html'));

// ── СТАРТ ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`SizeBook on port ${PORT}`));
}).catch(e => { console.error('DB init error:', e); process.exit(1); });
