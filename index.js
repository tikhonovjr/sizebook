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
function parseProduct(html, url) {
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
        if (offer && offer.price) {
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

  // 3. Сайтоспецифичные — __NEXT_DATA__ (Farfetch, Zara, Mytheresa)
  try {
    const nextRaw = $('#__NEXT_DATA__').html();
    if (nextRaw) {
      const nd = JSON.parse(nextRaw);
      const pp = nd?.props?.pageProps;

      // Farfetch
      const pd = pp?.productDetails || pp?.initialData?.productView || pp?.product;
      if (pd) {
        title = title || pd.name || pd.shortDescription || null;
        const imgs = pd.images || pd.colors?.[0]?.images;
        if (!image && imgs?.length) image = imgs[0].url || imgs[0].src || null;
        const pi = pd.priceInfo || pd.price || pd.pricing;
        if (!price && pi) {
          const val = pi.finalPrice || pi.price || pi.value;
          const cur = pi.currencyCode || pi.currency || '';
          if (val) price = cur ? `${val} ${cur}` : String(val);
        }
      }

      // Zara
      const zp = pp?.product || pp?.initialData?.product;
      if (!title && zp) {
        title = zp.name || null;
        const col = zp.detail?.colors?.[0] || zp.colors?.[0];
        if (!image && col?.images?.length) image = col.images[0].url || null;
        const zpr = zp.price || zp.detail?.price;
        if (!price && zpr) {
          const val = zpr.value || zpr.price;
          const cur = zpr.currency || '';
          if (val) price = cur ? `${val} ${cur}` : String(val);
        }
      }
    }
  } catch (_) {}

  // 4. Fallback — title страницы
  if (!title) {
    title = $('title').text().trim().split('|')[0].split('-')[0].trim() || null;
  }

  // Убираем длинные названия (обрезаем)
  if (title && title.length > 120) title = title.slice(0, 120).trim();

  return { title, price, image };
}

app.post('/parse', authenticateToken, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL обязателен' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Некорректный URL' }); }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const html = await response.text();
    const result = parseProduct(html, url);
    res.json(result); // { title, price, image } — точно такой же формат как ожидает фронтенд
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

    CREATE TABLE IF NOT EXISTS wishlist (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      brand TEXT,
      price TEXT,
      currency TEXT,
      image_url TEXT,
      product_url TEXT,
      notes TEXT,
      added_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Добавляем колонки если их нет (миграция)
  const migrations = [
    `ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS brand TEXT`,
    `ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS currency TEXT`,
    `ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS image_url TEXT`,
    `ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS product_url TEXT`,
    `ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS notes TEXT`,
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); } catch (_) {}
  }

  console.log('DB initialized');
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function authenticateToken(req, res, next) {
  const auth = req.headers['authorization'];
  const token = auth && auth.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Токен недействителен' });
    req.user = user;
    next();
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Заполните все поля' });
  if (username.length < 3)
    return res.status(400).json({ error: 'Имя пользователя минимум 3 символа' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username.toLowerCase(), email.toLowerCase(), hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Пользователь с таким именем или email уже существует' });
    }
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { login, password } = req.body;
  if (!login || !password)
    return res.status(400).json({ error: 'Введите логин и пароль' });
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1 OR email = $1',
      [login.toLowerCase()]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Неверный пароль' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── Sizes ────────────────────────────────────────────────────────────────────
app.get('/sizes', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT category, size_data FROM sizes WHERE user_id = $1',
      [req.user.id]
    );
    const sizes = {};
    result.rows.forEach(r => { sizes[r.category] = r.size_data; });
    res.json(sizes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка получения размеров' });
  }
});

app.post('/sizes', authenticateToken, async (req, res) => {
  const { category, size_data } = req.body;
  if (!category || !size_data)
    return res.status(400).json({ error: 'Нужны category и size_data' });
  try {
    await pool.query(
      `INSERT INTO sizes (user_id, category, size_data)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, category) DO UPDATE SET size_data = $3, updated_at = NOW()`,
      [req.user.id, category, JSON.stringify(size_data)]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сохранения размеров' });
  }
});

// ─── Wishlist ─────────────────────────────────────────────────────────────────
app.get('/wishlist', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM wishlist WHERE user_id = $1 ORDER BY added_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка получения вишлиста' });
  }
});

app.post('/wishlist', authenticateToken, async (req, res) => {
  const { name, brand, price, currency, image_url, product_url, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Название обязательно' });
  try {
    const result = await pool.query(
      `INSERT INTO wishlist (user_id, name, brand, price, currency, image_url, product_url, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.user.id, name, brand || null, price || null, currency || null,
       image_url || null, product_url || null, notes || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка добавления в вишлист' });
  }
});

app.delete('/wishlist/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM wishlist WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Элемент не найден' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

// ─── Публичный профиль ────────────────────────────────────────────────────────
app.get('/profile/:username', async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT id, username FROM users WHERE username = $1',
      [req.params.username.toLowerCase()]
    );
    if (userResult.rows.length === 0)
      return res.status(404).json({ error: 'Пользователь не найден' });
    const user = userResult.rows[0];

    const sizesResult = await pool.query(
      'SELECT category, size_data FROM sizes WHERE user_id = $1',
      [user.id]
    );
    const wishlistResult = await pool.query(
      'SELECT id, name, brand, price, currency, image_url, product_url FROM wishlist WHERE user_id = $1 ORDER BY added_at DESC',
      [user.id]
    );

    const sizes = {};
    sizesResult.rows.forEach(r => { sizes[r.category] = r.size_data; });

    res.json({
      username: user.username,
      sizes,
      wishlist: wishlistResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка получения профиля' });
  }
});

// ─── Парсер товаров ───────────────────────────────────────────────────────────
function parseProductFromHtml(html, url) {
  const $ = cheerio.load(html);
  const product = { url, name: null, brand: null, price: null, currency: null, image: null };

  // 1. JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html();
      if (!raw) return;
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        let obj = item['@type'] === 'Product' ? item : null;
        if (!obj && item['@graph']) obj = item['@graph'].find(x => x['@type'] === 'Product');
        if (!obj) continue;
        product.name  = product.name  || obj.name || null;
        product.brand = product.brand || (typeof obj.brand === 'string' ? obj.brand : obj.brand?.name) || null;
        const img = obj.image;
        product.image = product.image || (Array.isArray(img) ? img[0] : img) || null;
        const offer = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
        if (offer) {
          product.price    = product.price    || String(offer.price || '') || null;
          product.currency = product.currency || offer.priceCurrency || null;
        }
      }
    } catch (_) {}
  });

  // 2. OpenGraph
  product.name     = product.name     || $('meta[property="og:title"]').attr('content') || null;
  product.image    = product.image    || $('meta[property="og:image"]').attr('content') || null;
  product.price    = product.price    || $('meta[property="product:price:amount"]').attr('content') || null;
  product.currency = product.currency || $('meta[property="product:price:currency"]').attr('content') || null;

  // 3. Сайтоспецифичные парсеры
  try {
    const host = new URL(url).hostname;

    // Farfetch — данные в __NEXT_DATA__
    if (host.includes('farfetch.com')) {
      const nextDataStr = $('#__NEXT_DATA__').html();
      if (nextDataStr) {
        const nd = JSON.parse(nextDataStr);
        const pp = nd?.props?.pageProps;
        const pd = pp?.productDetails || pp?.initialData?.productView || pp?.product;
        if (pd) {
          product.name  = product.name  || pd.name || pd.shortDescription || null;
          product.brand = product.brand || pd.brand?.name || pd.brandName   || null;
          const imgs = pd.images || pd.colors?.[0]?.images;
          if (imgs?.length) product.image = product.image || imgs[0].url || imgs[0].src || null;
          const pi = pd.priceInfo || pd.price || pd.pricing;
          if (pi) {
            product.price    = product.price    || String(pi.finalPrice || pi.price || pi.value || '') || null;
            product.currency = product.currency || pi.currencyCode || pi.currency || null;
          }
        }
      }
    }

    // Zara
    if (host.includes('zara.com')) {
      const nextDataStr = $('#__NEXT_DATA__').html();
      if (nextDataStr) {
        const nd = JSON.parse(nextDataStr);
        const prod = nd?.props?.pageProps?.product || nd?.props?.pageProps?.initialData?.product;
        if (prod) {
          product.name  = product.name  || prod.name || null;
          product.brand = product.brand || 'Zara';
          const col = prod.detail?.colors?.[0] || prod.colors?.[0];
          if (col?.images?.length) product.image = product.image || col.images[0].url || null;
          const pr = prod.price || prod.detail?.price;
          if (pr) {
            product.price    = product.price    || String(pr.value || pr.price || '') || null;
            product.currency = product.currency || pr.currency || null;
          }
        }
      }
    }

    // ASOS
    if (host.includes('asos.com')) {
      const scriptContent = $('script[type="application/ld+json"]').first().html();
      if (!scriptContent) {
        // fallback: ищем в data-attrs
        product.name  = product.name  || $('h1[data-auto-id="product-title"]').text().trim() || null;
        product.brand = product.brand || $('[data-auto-id="brand-name"]').text().trim() || null;
        product.price = product.price || $('[data-auto-id="product-price"]').text().trim() || null;
      }
    }

    // Net-a-Porter / Mr Porter
    if (host.includes('net-a-porter.com') || host.includes('mrporter.com')) {
      product.brand = product.brand || $('[data-test-id="designer-name"], .product-details__designer').first().text().trim() || null;
      product.name  = product.name  || $('[data-test-id="product-name"], .product-details__name').first().text().trim() || null;
      product.price = product.price || $('[data-test-id="price"] [data-test-id="full-price"]').first().text().trim() || null;
    }

    // SSENSE
    if (host.includes('ssense.com')) {
      product.brand = product.brand || $('.pdp-product__brand, .product-details-brand').first().text().trim() || null;
      product.name  = product.name  || $('.pdp-product__name, .product-details-name').first().text().trim() || null;
      product.price = product.price || $('.pdp-product__price, .product-details-price').first().text().trim() || null;
    }

    // Mytheresa
    if (host.includes('mytheresa.com')) {
      const nextDataStr = $('#__NEXT_DATA__').html();
      if (nextDataStr) {
        const nd = JSON.parse(nextDataStr);
        const pd = nd?.props?.pageProps?.product || nd?.props?.pageProps?.initialData;
        if (pd) {
          product.name  = product.name  || pd.name || null;
          product.brand = product.brand || pd.brand?.name || pd.designer?.name || null;
          product.image = product.image || pd.images?.[0]?.src || pd.media?.[0]?.url || null;
          product.price = product.price || String(pd.price?.current?.value || pd.price?.amount || '') || null;
          product.currency = product.currency || pd.price?.current?.currency || pd.currency || null;
        }
      }
    }

    // H&M
    if (host.includes('hm.com')) {
      product.name  = product.name  || $('h1.product-detail-main-image-container__name, h1[class*="ProductName"]').first().text().trim() || null;
      product.brand = product.brand || 'H&M';
      product.price = product.price || $('[class*="price"] [class*="Price"]').first().text().trim() || null;
    }

    // Mango
    if (host.includes('mango.com')) {
      product.brand = product.brand || 'Mango';
      product.name  = product.name  || $('h1.product-name, [class*="ProductName"]').first().text().trim() || null;
      product.price = product.price || $('[class*="sale-price"], [class*="price"]').first().text().trim() || null;
    }

  } catch (_) {}

  // 4. Fallback — title страницы
  if (!product.name) {
    const title = $('title').text().trim();
    product.name = title.split('|')[0].split('-')[0].trim() || null;
  }

  // Форматируем цену
  if (product.price && product.currency) {
    product.priceFormatted = `${product.price} ${product.currency}`;
  } else if (product.price) {
    product.priceFormatted = product.price;
  }

  // Убираем пустые строки
  Object.keys(product).forEach(k => {
    if (product[k] === '' || product[k] === null) delete product[k];
  });

  return product;
}

app.post('/parse', authenticateToken, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL обязателен' });

  try {
    new URL(url); // валидация
  } catch {
    return res.status(400).json({ error: 'Некорректный URL' });
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok && response.status !== 200) {
      return res.status(502).json({ error: `Сайт вернул ошибку ${response.status}` });
    }

    const html = await response.text();
    const product = parseProductFromHtml(html, url);
    res.json({ success: true, product });

  } catch (err) {
    console.error('Parse error:', err.message);
    if (err.name === 'TimeoutError') {
      return res.status(504).json({ error: 'Сайт не ответил вовремя' });
    }
    res.status(500).json({ error: 'Не удалось загрузить страницу товара', details: err.message });
  }
});

// ─── Статика ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'sizebook4.html')));

// ─── Старт ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`SizeBook running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
