const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cheerio = require('cheerio');
const { chromium } = require('playwright-core');

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
  // Миграция: добавляем недостающие колонки, если таблица wishlist создавалась раньше без них
  await pool.query(`
    ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS added_at TIMESTAMP DEFAULT NOW();
    ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS shop TEXT;
    ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS url TEXT;
    ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS price TEXT;
    ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS size TEXT;
    ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS image TEXT;
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
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка', detail: e.message }); }
});

app.post('/sizes', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO sizes (user_id, data) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET data=$2, updated_at=NOW()`,
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

// ── ПАРСЕР ────────────────────────────────────────────────────────────────────
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
  'Connection': 'keep-alive',
};

// Headless browser — синглтон, переиспользуется между запросами
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
async function parseViaPlaywright(url, locale = 'ru-RU') {
  try {
    const browser = await getHeadlessBrowser();
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
      locale,
      extraHTTPHeaders: { 'Accept-Language': `${locale},en;q=0.8` },
    });
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
async function parseWildberries(url, dbg) {
  try {
    const nm = url.match(/\/catalog\/(\d+)/)?.[1];
    dbg.push(`nm from url: ${nm}`);
    if (!nm) return null;
    const id = Number(nm);
    const vol = Math.floor(id / 100000);
    const part = Math.floor(id / 1000);
    dbg.push(`vol=${vol} part=${part}`);

    const basket = (() => {
      const t = [143,287,431,719,1007,1061,1115,1169,1313,1601,1655,1919,2045,2189,2405,
                 2621,2837,3053,3269,3485,3701,3917,4133,4349,4565,4781,4997,5213,5429,
                 5645,5861,6077,6293,6509,6725,6941,7157,7373,7589,7805];
      const i = t.findIndex(v => vol <= v);
      return String(i === -1 ? t.length + 1 : i + 1).padStart(2, '0');
    })();
    dbg.push(`basket=${basket}`);

    const base = `https://basket-${basket}.wbbasket.ru/vol${vol}/part${part}/${nm}`;
    dbg.push(`base=${base}`);
    const cdnHeaders = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };

    const cardUrl = `${base}/info/ru/card.json`;
    dbg.push(`fetching ${cardUrl}`);
    const cardRes = await fetch(cardUrl, { headers: cdnHeaders, signal: AbortSignal.timeout(8000) });
    dbg.push(`cardRes: ${cardRes.status} ok=${cardRes.ok}`);
    if (!cardRes.ok) {
      const body = await cardRes.text().catch(() => '');
      dbg.push(`cardRes body (first 200): ${body.slice(0, 200)}`);
      return null;
    }
    const card = await cardRes.json();
    const title = card.imt_name || null;
    dbg.push(`title="${title}"`);
    const image = `${base}/images/big/1.webp`;

    // Пробуем несколько WB price-эндпоинтов
    let price = null;
    const wbPriceHeaders = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.wildberries.ru/',
      'Origin': 'https://www.wildberries.ru',
    };
    const subjectId = card?.data?.subject_id;
    const priceEndpoints = [
      // Catalog API с subject_id из card.json
      subjectId ? `https://catalog.wb.ru/catalog/${subjectId}/catalog?appType=1&curr=rub&dest=-1257786&sort=popular&limit=1&nm=${nm}` : null,
      // Catalog API без subject (широкий запрос)
      `https://catalog.wb.ru/catalog/v2/filters?appType=1&curr=rub&dest=-1257786&nm=${nm}`,
      // Search API (может работать с Railway IP при других заголовках)
      `https://search.wb.ru/exactmatch/ru/common/v7/search?appType=1&curr=rub&dest=-1257786&resultset=catalog&limit=1&query=${nm}`,
    ].filter(Boolean);

    for (const ep of priceEndpoints) {
      if (price) break;
      dbg.push(`trying price endpoint: ${ep}`);
      try {
        const r = await fetch(ep, { headers: wbPriceHeaders, signal: AbortSignal.timeout(5000) });
        dbg.push(`  → ${r.status} ok=${r.ok}`);
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          dbg.push(`  → body: ${body.slice(0, 120)}`);
          continue;
        }
        const sd = await r.json();
        const prod = sd?.data?.products?.find(p => String(p.id) === nm);
        dbg.push(`  → prod found: ${!!prod} salePriceU=${prod?.salePriceU} priceU=${prod?.priceU}`);
        const priceKopecks = prod?.salePriceU ?? prod?.priceU;
        if (priceKopecks) price = `${Math.round(priceKopecks / 100)} ₽`;
      } catch (e) {
        dbg.push(`  → error: ${e.message}`);
      }
    }

    dbg.push(`result: title="${title}" price="${price}" image="${image}"`);
    return { title, price, image };
  } catch (e) {
    dbg.push(`parseWildberries threw: ${e.message}`);
    return null;
  }
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

  // Детект страниц-блокировок антибота — не отдаём их как валидный результат
  const blockPatterns = /^(access denied|forbidden|attention required|just a moment|are you a robot|error \d{3})/i;
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
  const { url, _diag } = req.body;
  if (!url) return res.status(400).json({ error: 'URL обязателен' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Некорректный URL' }); }

  const host = new URL(url).hostname;
  const dbg = [];
  dbg.push(`url=${url}`);
  dbg.push(`host=${host}`);

  // 12storeez — JS-челлендж, сразу Playwright
  if (host.includes('12storeez')) {
    dbg.push('branch=12storeez');
    const result = await parseViaPlaywright(url);
    console.log(`[parse] 12storeez playwright:`, result);
    const out = result || { title: null, price: null, image: null };
    return res.json(_diag ? { ...out, _debug: dbg } : out);
  }

  // Wildberries — CDN API, без антибота
  if (host.includes('wildberries')) {
    dbg.push('branch=wildberries');
    const result = await parseWildberries(url, dbg);
    console.log(`[parse] wildberries cdn:`, result, dbg);
    const out = result || { title: null, price: null, image: null };
    return res.json(_diag ? { ...out, _debug: dbg } : out);
  }

  const BOT_PROTECTED = host.includes('net-a-porter') || host.includes('matchesfashion') || host.includes('farfetch');

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
    console.log(`[parse] direct fetch (${host}):`, direct);
    accumulated = mergeParseResults(accumulated, direct);

    // Для обычных сайтов — если что-то нашли, сразу отдаём
    if (!BOT_PROTECTED && (accumulated.title || accumulated.price || accumulated.image)) {
      return res.json(accumulated);
    }
  } catch (e) {
    console.log(`[parse] direct fetch error (${host}):`, e.message);
    if (e.name === 'TimeoutError' && !BOT_PROTECTED)
      return res.status(504).json({ error: 'Сайт не ответил' });
  }

  // Для обычных сайтов без результата — возвращаем null
  if (!BOT_PROTECTED) {
    return res.json(accumulated);
  }

  // Шаг b: BOT_PROTECTED — пробуем Playwright (умеет price из JSON-LD/og:price)
  if (!accumulated.title || !accumulated.price) {
    const playwright = await parseViaPlaywright(url);
    console.log(`[parse] playwright (${host}):`, playwright);
    accumulated = mergeParseResults(accumulated, playwright);
  }

  // Шаг c: если после Playwright всё ещё нет title или image — дополняем через внешние OG-парсеры
  // (они умеют title/image, но не price — поэтому идут последними)
  if (!accumulated.title || !accumulated.image) {
    const jsonlink = await parseViaJsonlink(url);
    console.log(`[parse] jsonlink (${host}):`, jsonlink);
    accumulated = mergeParseResults(accumulated, jsonlink);

    if (!accumulated.title || !accumulated.image) {
      const iframely = await parseViaIframely(url);
      console.log(`[parse] iframely (${host}):`, iframely);
      accumulated = mergeParseResults(accumulated, iframely);
    }
  }

  // Шаг d: отдаём что есть (price может быть null — это нормально, если ни один метод не нашёл)
  console.log(`[parse] final result (${host}):`, accumulated);
  res.json(accumulated);
});

// ── СТАТИКА ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(__dirname + '/sizebook4.html'));

// ── СТАРТ ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`SizeBook on port ${PORT}`));
}).catch(e => { console.error('DB init error:', e); process.exit(1); });
