const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'sizebook-secret-change-in-prod';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sizes (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, category)
    );
    CREATE TABLE IF NOT EXISTS wishlist (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      shop TEXT,
      url TEXT,
      image TEXT,
      price TEXT,
      size TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('DB ready');
}

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.post('/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'All fields required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username.toLowerCase(), email.toLowerCase(), hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username or email already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'User not found' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Wrong password' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/parse', auth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 10000
    });
    const html = await response.text();
    const $ = cheerio.load(html);

    const title =
      $('meta[property="og:title"]').attr('content') ||
      $('meta[name="twitter:title"]').attr('content') ||
      $('title').text() || '';

    const image =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') || '';

    const priceSelectors = [
      '[itemprop="price"]', '[class*="price"]', '[class*="Price"]',
      '[data-testid*="price"]', '.product-price', '#price'
    ];
    let price = $('meta[property="product:price:amount"]').attr('content') || '';
    const currency = $('meta[property="product:price:currency"]').attr('content') || '';
    if (price && currency) price = `${price} ${currency}`;
    if (!price) {
      for (const sel of priceSelectors) {
        const text = $(sel).first().text().trim();
        if (text && /\d/.test(text) && text.length < 30) { price = text; break; }
      }
    }

    let shop = '';
    try { shop = new URL(url).hostname.replace('www.', ''); } catch {}

    res.json({ title: title.trim(), image, price: price.trim(), shop, url });
  } catch (e) {
    res.status(422).json({ error: 'Could not fetch page', detail: e.message });
  }
});

app.get('/wishlist', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM wishlist WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json(result.rows);
});

app.post('/wishlist', auth, async (req, res) => {
  const { title, shop, url, image, price, size } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  const result = await pool.query(
    'INSERT INTO wishlist (user_id, title, shop, url, image, price, size) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [req.user.id, title, shop, url, image, price, size]
  );
  res.json(result.rows[0]);
});

app.delete('/wishlist/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM wishlist WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

app.get('/profile/:username', async (req, res) => {
  try {
    const user = await pool.query('SELECT id, username FROM users WHERE username = $1', [req.params.username]);
    if (!user.rows[0]) return res.status(404).json({ error: 'User not found' });
    const wishlist = await pool.query('SELECT * FROM wishlist WHERE user_id = $1 ORDER BY created_at DESC', [user.rows[0].id]);
    res.json({ user: user.rows[0], wishlist: wishlist.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/sizes', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM sizes WHERE user_id = $1', [req.user.id]);
  res.json(result.rows);
});

app.post('/sizes', auth, async (req, res) => {
  const { category, data } = req.body;
  await pool.query(
    `INSERT INTO sizes (user_id, category, data) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, category) DO UPDATE SET data=$3, updated_at=NOW()`,
    [req.user.id, category, JSON.stringify(data)]
  );
  res.json({ ok: true });
});

app.get('/', (req, res) => res.sendFile(__dirname + '/sizebook4.html'));

initDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
