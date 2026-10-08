"""SizeBook fetcher — отдельный сервис для магазинов с жёстким антиботом (Ozon, Wildberries).

Почему отдельный сервис: здесь живёт настоящий браузер (Camoufox — Firefox с правдоподобным
отпечатком, в виртуальном дисплее). Он проходит JS-проверку Ozon/WB так же, как обычный
посетитель, и открывает ровно ту страницу, ссылку на которую прислал пользователь.
Основной бэкенд (desirable-cat) ходит сюда по внутренней сети Railway.

API (внутренняя сеть + заголовок x-fetcher-secret):
  POST /product {url}  -> {ok, shop, title, price, currency, card_price, image, final_url, ms, steps}
  GET  /health
При PROBE=1 на старте прогоняет набор проверок и пишет результаты в лог (строки PROBE ...).
"""
import asyncio, json, os, re, time, traceback, html as htmllib
from urllib.parse import urlparse

from aiohttp import web

SECRET = os.environ.get('FETCHER_SECRET', '')
PORT = int(os.environ.get('PORT', '8080'))
MAX_PAGES = int(os.environ.get('FETCHER_MAX_PAGES', '2'))
RECYCLE_AFTER = int(os.environ.get('FETCHER_RECYCLE_AFTER', '150'))  # перезапуск браузера каждые N страниц

CAPTCHA_RE = re.compile(r'<title>Antibot Captcha</title>|fab_cp_|Сопоставьте пазл', re.I)


def log(kind, **kw):
    print(kind, json.dumps(kw, ensure_ascii=False)[:4000], flush=True)


# ── браузер ──────────────────────────────────────────────────────────────────
class Browser:
    """Один браузер на процесс, по постоянному контексту (с куками) на каждый магазин.

    Куки, полученные после прохождения JS-проверки, переиспользуются — повторные
    запросы к тому же магазину идут без проверки и быстрее.
    """

    def __init__(self):
        self.cm = None
        self.br = None
        self.ctx = {}
        self.lock = asyncio.Lock()
        self.sem = asyncio.Semaphore(MAX_PAGES)
        self.pages_opened = 0
        self.active = 0

    async def _start(self):
        from camoufox.async_api import AsyncCamoufox
        t = time.time()
        self.cm = AsyncCamoufox(headless='virtual', os='windows', locale='ru-RU', block_webrtc=True,
                                humanize=False, i_know_what_im_doing=True,
                                firefox_user_prefs={'media.autoplay.default': 5})
        self.br = await self.cm.__aenter__()
        self.ctx = {}
        self.pages_opened = 0
        log('BROWSER', event='started', ms=int((time.time() - t) * 1000))

    async def _stop(self):
        try:
            if self.cm:
                await self.cm.__aexit__(None, None, None)
        except Exception:
            pass
        self.cm = self.br = None
        self.ctx = {}

    async def context(self, key):
        async with self.lock:
            need_restart = self.br is None or not self.br.is_connected()
            if not need_restart and self.pages_opened >= RECYCLE_AFTER and self.active == 0:
                need_restart = True
            if need_restart:
                await self._stop()
                await self._start()
            if key not in self.ctx:
                self.ctx[key] = await self.br.new_context(locale='ru-RU', timezone_id='Europe/Moscow',
                                                          viewport={'width': 1366, 'height': 900})
                # WB: картинки/шрифты не нужны — страница грузится быстрее.
                # Ozon: не трогаем — его JS-проверка сама загружает картинки.
                if key == 'wb':
                    await self.ctx[key].route(re.compile(r'\.(png|jpe?g|webp|gif|avif|mp4|webm|woff2?|ttf)(\?|$)', re.I),
                                              lambda route: route.abort())
            self.pages_opened += 1
            return self.ctx[key]

    async def reset_context(self, key):
        async with self.lock:
            c = self.ctx.pop(key, None)
        if c:
            try:
                await c.close()
            except Exception:
                pass


BROWSER = Browser()


async def open_page(key, url, *, on_response=None, timeout=25, ready=None):
    """Открывает url в контексте магазина key, ждёт, пока пройдёт антибот и выполнится ready(html).
    Возвращает (html, final_url, first_status, steps)."""
    steps = []
    async with BROWSER.sem:
        BROWSER.active += 1
        try:
            ctx = await BROWSER.context(key)
            page = await ctx.new_page()
            if on_response:
                page.on('response', on_response)
            try:
                t = time.time()
                resp = await page.goto(url, wait_until='domcontentloaded', timeout=timeout * 1000)
                status = resp.status if resp else None
                steps.append({'goto': status, 'ms': int((time.time() - t) * 1000)})
                deadline = time.time() + timeout
                html = ''
                while time.time() < deadline:
                    try:
                        html = await page.content()
                    except Exception:  # страница перезагружается после проверки
                        await asyncio.sleep(0.5)
                        continue
                    if not CAPTCHA_RE.search(html[:30000]) and (ready is None or ready(html)):
                        break
                    await asyncio.sleep(0.7)
                st = {'settled_ms': int((time.time() - t) * 1000), 'captcha': bool(CAPTCHA_RE.search(html[:30000]))}
                if ready is not None and not ready(html):
                    tm = re.search(r'<title[^>]*>([^<]*)', html)
                    st.update(not_ready=True, title=tm.group(1)[:80] if tm else None, len=len(html), url=page.url[:150],
                              head=re.sub(r'\s+', ' ', re.sub(r'<(script|style)[^>]*>.*?</\1>', '', html, flags=re.S))[:600])
                steps.append(st)
                return html, page.url, status, steps
            finally:
                try:
                    await page.close()
                except Exception:
                    pass
        finally:
            BROWSER.active -= 1


# ── разбор ───────────────────────────────────────────────────────────────────
def meta(html, prop):
    m = re.search(r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]*content=["\']([^"\']*)' % re.escape(prop), html) \
        or re.search(r'<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']%s["\']' % re.escape(prop), html)
    return htmllib.unescape(m.group(1)).strip() if m else None


def jsonld_products(html):
    out = []
    for m in re.finditer(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.S):
        try:
            d = json.loads(m.group(1))
        except Exception:
            continue
        for x in (d if isinstance(d, list) else d.get('@graph', [d]) if isinstance(d, dict) else []):
            if isinstance(x, dict) and str(x.get('@type', '')).lower() == 'product':
                out.append(x)
    return out


def to_num(s):
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    s = re.sub(r'[\s   ]', '', str(s)).replace(',', '.')
    m = re.search(r'\d+(?:\.\d+)?', s)
    return float(m.group(0)) if m else None


def first_image(v):
    if isinstance(v, list):
        v = v[0] if v else None
    if isinstance(v, dict):
        v = v.get('url') or v.get('contentUrl')
    return v


# ── Ozon ─────────────────────────────────────────────────────────────────────
OZON_SHORT_RE = re.compile(r'^https?://(?:www\.)?ozon\.ru/t/([A-Za-z0-9_-]+)')


def ozon_ready(html):
    return 'application/ld+json' in html or 'webPrice' in html


def parse_ozon(html):
    res = {'title': None, 'price': None, 'currency': 'RUB', 'card_price': None, 'image': None, 'sku': None}
    for p in jsonld_products(html):
        res['title'] = res['title'] or p.get('name')
        res['image'] = res['image'] or first_image(p.get('image'))
        res['sku'] = res['sku'] or p.get('sku')
        offers = p.get('offers') or {}
        if isinstance(offers, list):
            offers = offers[0] if offers else {}
        res['price'] = res['price'] or to_num(offers.get('price') or offers.get('lowPrice'))
        res['currency'] = offers.get('priceCurrency') or res['currency']
    # виджет цены: в data-state лежат обычная цена и цена по Ozon-карте
    m = re.search(r'id="state-webPrice-[^"]*"[^>]*data-state=\'([^\']+)\'', html) \
        or re.search(r'data-state=\'(\{[^\']*"cardPrice"[^\']*)\'', html)
    if m:
        try:
            st = json.loads(htmllib.unescape(m.group(1)))
            res['card_price'] = to_num(st.get('cardPrice'))
            res['price'] = res['price'] or to_num(st.get('price'))
            res['original_price'] = to_num(st.get('originalPrice'))
        except Exception:
            pass
    res['title'] = res['title'] or meta(html, 'og:title')
    res['image'] = res['image'] or meta(html, 'og:image')
    if res['title']:
        res['title'] = htmllib.unescape(res['title']).strip()
    return res


async def ozon_product(url):
    steps = []
    short = OZON_SHORT_RE.match(url)
    target = f'https://www.ozon.ru/t/{short.group(1)}' if short else url
    html, final, status, st = await open_page('ozon', target, ready=ozon_ready)
    steps += st
    if CAPTCHA_RE.search(html[:30000]):
        # Слайдер-капчу Ozon показывает «холодному» посетителю. Заходим на главную (обычная
        # JS-проверка, проходит сама), получаем куки и повторяем.
        steps.append({'retry': 'warmup'})
        await open_page('ozon', 'https://www.ozon.ru/', ready=lambda h: 'ozon' in h.lower(), timeout=20)
        html, final, status, st = await open_page('ozon', target, ready=ozon_ready)
        steps += st
    if CAPTCHA_RE.search(html[:30000]):
        steps.append({'retry': 'fresh_context'})
        await BROWSER.reset_context('ozon')
        await open_page('ozon', 'https://www.ozon.ru/', ready=lambda h: 'ozon' in h.lower(), timeout=20)
        html, final, status, st = await open_page('ozon', target, ready=ozon_ready)
        steps += st
    if CAPTCHA_RE.search(html[:30000]):
        return {'ok': False, 'error': 'captcha', 'final_url': final, 'steps': steps}
    r = parse_ozon(html)
    final_clean = re.sub(r'\?.*$', '', final or url)
    return {'ok': bool(r['title']), **r, 'final_url': final_clean, 'steps': steps}


# ── Wildberries ──────────────────────────────────────────────────────────────
WB_NM_RE = re.compile(r'/catalog/(\d+)')


async def wb_product(url):
    """Цена WB приходит в браузер из JSON-запроса карточки (cards/v4/detail) — его и ловим."""
    m = WB_NM_RE.search(url)
    nm = m.group(1) if m else None
    captured = {}
    done = asyncio.Event()

    async def on_response(resp):
        u = resp.url
        if '/cards/' in u and 'detail' in u and (not nm or nm in u):
            try:
                j = await resp.json()
            except Exception:
                return
            prods = j.get('products') or (j.get('data') or {}).get('products') or []
            for p in prods:
                if not nm or str(p.get('id')) == nm:
                    captured['p'] = p
                    done.set()
                    return

    page_url = f'https://www.wildberries.ru/catalog/{nm}/detail.aspx' if nm else url
    steps = []
    html, final, status, st = await open_page('wb', page_url, on_response=lambda r: asyncio.ensure_future(on_response(r)),
                                              ready=lambda h: done.is_set(), timeout=25)
    steps += st
    if not done.is_set():
        try:
            await asyncio.wait_for(done.wait(), 5)
        except asyncio.TimeoutError:
            pass
    p = captured.get('p')
    if not p:
        return {'ok': False, 'error': 'no_card_json', 'final_url': final, 'steps': steps}
    price = None
    for sz in p.get('sizes') or []:
        pr = (sz.get('price') or {})
        v = pr.get('product') or pr.get('total')
        if v:
            price = v / 100
            break
    if price is None and p.get('salePriceU'):
        price = p['salePriceU'] / 100
    title = p.get('name')
    if p.get('brand') and title and p['brand'].lower() not in title.lower():
        title = f"{p['brand']} / {title}"
    return {'ok': True, 'title': title, 'price': price, 'currency': 'RUB', 'image': None, 'sku': nm,
            'final_url': f'https://www.wildberries.ru/catalog/{nm}/detail.aspx', 'steps': steps}


# ── маршрутизация ────────────────────────────────────────────────────────────
def shop_of(url):
    h = (urlparse(url).hostname or '').lower()
    if h.endswith('ozon.ru'):
        return 'ozon'
    if h.endswith('wildberries.ru') or h.endswith('wb.ru'):
        return 'wb'
    return None


async def product(url):
    t = time.time()
    shop = shop_of(url)
    try:
        if shop == 'ozon':
            r = await asyncio.wait_for(ozon_product(url), 70)
        elif shop == 'wb':
            r = await asyncio.wait_for(wb_product(url), 45)
        else:
            r = {'ok': False, 'error': 'unsupported_shop'}
    except asyncio.TimeoutError:
        r = {'ok': False, 'error': 'timeout'}
    except Exception as e:
        log('ERROR', url=url, err=traceback.format_exc()[-1500:])
        r = {'ok': False, 'error': str(e)[:200]}
    r['shop'] = shop
    r['ms'] = int((time.time() - t) * 1000)
    log('PRODUCT', url=url, **{k: v for k, v in r.items() if k != 'steps'}, steps=r.get('steps'))
    return r


# ── HTTP ─────────────────────────────────────────────────────────────────────
async def h_health(req):
    return web.json_response({'ok': True, 'browser': BROWSER.br is not None, 'active': BROWSER.active,
                              'pages': BROWSER.pages_opened})


async def h_product(req):
    if not SECRET or req.headers.get('x-fetcher-secret') != SECRET:
        return web.json_response({'error': 'forbidden'}, status=403)
    try:
        body = await req.json()
    except Exception:
        return web.json_response({'error': 'bad json'}, status=400)
    url = str(body.get('url') or '')
    if not re.match(r'^https?://', url) or not shop_of(url):
        return web.json_response({'error': 'unsupported url'}, status=400)
    return web.json_response(await product(url))


PROBE_URLS = [u for u in os.environ.get('PROBE_URLS', '').split(',') if u.strip()]


async def step(page, url, wait=20):
    t = time.time()
    try:
        resp = await page.goto(url, wait_until='domcontentloaded', timeout=wait * 1000)
        st = resp.status if resp else None
    except Exception as e:
        st = 'ERR ' + str(e)[:80]
    html = ''
    deadline = time.time() + wait
    while time.time() < deadline:
        try:
            html = await page.content()
        except Exception:
            await asyncio.sleep(0.5); continue
        if 'application/ld+json' in html or ('og:title' in html and 'Antibot' not in html[:3000]):
            break
        await asyncio.sleep(0.7)
    tm = re.search(r'<title[^>]*>([^<]*)', html)
    try:
        vis = await page.evaluate("() => { const c = document.querySelector('.container'); return c ? !c.classList.contains('hidden') : null }")
    except Exception:
        vis = 'err'
    log('SCEN_STEP', slider_visible=vis, url=url[:80], status=st, ms=int((time.time() - t) * 1000), final=page.url[:160],
        title=(tm.group(1)[:90] if tm else None), slider='Сопоставьте' in html, antibot='Antibot' in html[:3000],
        jsonld='application/ld+json' in html, len=len(html))


async def scenarios():
    await BROWSER.context('wb')  # запуск браузера
    prod = 'https://www.ozon.ru/product/noski-muzhskie-muzhskie-5-par-3148849655/'
    short = 'https://www.ozon.ru/t/fBkpTSz'
    plans = {
        'S1_product': [prod],
        'S2_home_then_short': ['https://www.ozon.ru/', short],
        'S3_product_then_short': [prod, short],
        'S4_short_nowww': ['https://ozon.ru/t/fBkpTSz'],
        'S5_product_twice': [prod, prod],
        'S6_product_then_short': [prod, short],
        'S7_short_www': [short],
    }
    for name, urls in plans.items():
        ctx = await BROWSER.br.new_context(locale='ru-RU', timezone_id='Europe/Moscow', viewport={'width': 1366, 'height': 900})
        page = await ctx.new_page()
        log('SCEN', name=name)
        for u in urls:
            await step(page, u)
        cookies = await ctx.cookies()
        log('SCEN_COOKIES', name=name, names=[c['name'] for c in cookies if 'ozon' in c.get('domain', '')][:30])
        await ctx.close()
    log('SCEN_END')


async def run_probes():
    await asyncio.sleep(1)
    if os.environ.get('PROBE_SCEN') == '1':
        try:
            await scenarios()
        except Exception:
            log('ERROR', err=traceback.format_exc()[-1500:])
        return
    log('PROBE_START', n=len(PROBE_URLS))
    for u in PROBE_URLS:
        r = await product(u.strip())
        log('PROBE', url=u, ok=r.get('ok'), ms=r.get('ms'), title=r.get('title'), price=r.get('price'),
            card_price=r.get('card_price'), image=r.get('image'), error=r.get('error'), final=r.get('final_url'))
    log('PROBE_END')


async def on_start(app):
    async def warm():
        try:
            await BROWSER.context('ozon')
        except Exception:
            log('ERROR', err=traceback.format_exc()[-1500:])
    if os.environ.get('PROBE') == '1':
        asyncio.create_task(run_probes())
    else:
        asyncio.create_task(warm())


def main():
    app = web.Application(client_max_size=256 * 1024)
    app.router.add_get('/health', h_health)
    app.router.add_post('/product', h_product)
    app.on_startup.append(on_start)
    web.run_app(app, host='::', port=PORT, access_log=None)


if __name__ == '__main__':
    main()
