"""SizeBook fetcher: отдельный сервис для магазинов с антиботом (WB, Ozon).

- curl_cffi: HTTP-клиент с TLS/HTTP2-отпечатком настоящего браузера.
- Camoufox: Firefox с правдоподобным отпечатком, в виртуальном дисплее (не headless).
- RU_PROXY_URL: российский выход (нужен для Ozon, который режет зарубежные IP).

HTTP API (только внутренняя сеть Railway + секрет):
  POST /fetch {url, mode} -> {status, final_url, html|json, ms}
  GET  /health
При PROBE=1 на старте прогоняет набор проверок и пишет результаты в лог (строки PROBE {...}).
"""
import asyncio, json, os, re, time, traceback
from urllib.parse import urlparse

from aiohttp import web
from curl_cffi import requests as creq

RU_PROXY = os.environ.get('RU_PROXY_URL') or None
SECRET = os.environ.get('FETCHER_SECRET', '')
PORT = int(os.environ.get('PORT', '8080'))

CAPTCHA_RE = re.compile(r'fab_cp_|Antibot Captcha|Сопоставьте пазл|Подтвердите, что вы не бот|Доступ ограничен|x-pow', re.I)


def log(kind, **kw):
    print(kind, json.dumps(kw, ensure_ascii=False)[:4000], flush=True)


# ── curl_cffi ────────────────────────────────────────────────────────────────
def cffi_get(url, impersonate='chrome', proxy=None, headers=None, timeout=20):
    t = time.time()
    try:
        s = creq.Session(impersonate=impersonate)
        r = s.get(url, headers=headers or {}, proxy=proxy, timeout=timeout, allow_redirects=True)
        return {'status': r.status_code, 'final_url': r.url, 'text': r.text,
                'ms': int((time.time() - t) * 1000), 'cookies': list(s.cookies.keys())}
    except Exception as e:
        return {'status': None, 'error': str(e)[:300], 'ms': int((time.time() - t) * 1000)}


# ── Camoufox ─────────────────────────────────────────────────────────────────
_browser = None
_browser_lock = asyncio.Lock()


def proxy_conf():
    if not RU_PROXY:
        return None
    u = urlparse(RU_PROXY)
    c = {'server': f'{u.scheme}://{u.hostname}:{u.port}'}
    if u.username:
        c['username'] = u.username
        c['password'] = u.password or ''
    return c


async def get_browser(use_proxy=True):
    """Один живой браузер на процесс (запуск ~3–5 с, дальше страницы открываются быстро)."""
    global _browser
    from camoufox.async_api import AsyncCamoufox
    async with _browser_lock:
        if _browser is None:
            opts = dict(headless='virtual', os='windows', locale='ru-RU', block_webrtc=True,
                        humanize=False, i_know_what_im_doing=True)
            px = proxy_conf() if use_proxy else None
            if px:
                opts['proxy'] = px
                opts['geoip'] = True
            cm = AsyncCamoufox(**opts)
            br = await cm.__aenter__()
            _browser = (cm, br)
        return _browser[1]


async def browser_get(url, wait_selector=None, timeout=30, settle=2.5, use_proxy=None):
    t = time.time()
    if use_proxy is None:
        use_proxy = os.environ.get('BROWSER_PROXY', '0') == '1'
    br = await get_browser(use_proxy)
    ctx = await br.new_context(locale='ru-RU')
    page = await ctx.new_page()
    out = {}
    try:
        resp = await page.goto(url, wait_until='domcontentloaded', timeout=timeout * 1000)
        out['first_status'] = resp.status if resp else None
        # антибот-страница Ozon сама перезагружается после JS-проверки — ждём уход с неё
        deadline = time.time() + timeout
        while time.time() < deadline:
            html = await page.content()
            if not CAPTCHA_RE.search(html[:20000]) and ('og:title' in html or '<h1' in html):
                break
            await asyncio.sleep(1)
        if wait_selector:
            try:
                await page.wait_for_selector(wait_selector, timeout=8000)
            except Exception:
                pass
        await asyncio.sleep(settle)
        out['html'] = await page.content()
        out['final_url'] = page.url
        out['title'] = await page.title()
    except Exception as e:
        out['error'] = str(e)[:300]
        try:
            out['html'] = await page.content()
            out['final_url'] = page.url
        except Exception:
            pass
    finally:
        await ctx.close()
    out['ms'] = int((time.time() - t) * 1000)
    return out


# ── извлечение для логов ─────────────────────────────────────────────────────
def summarize(text, n=250):
    if not text:
        return {}
    meta = {}
    for k in ('og:title', 'og:image', 'og:description', 'product:price:amount'):
        m = re.search(r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]+content=["\']([^"\']*)' % re.escape(k), text)
        if m:
            meta[k] = m.group(1)[:200]
    title = re.search(r'<title[^>]*>([^<]*)', text)
    prices = re.findall(r'(\d[\d\s  ]{1,9})\s?₽', text)[:8]
    return {'len': len(text), 'title': title.group(1)[:150] if title else None, 'meta': meta,
            'captcha': bool(CAPTCHA_RE.search(text)), 'rub': [p.strip() for p in prices],
            'jsonld': 'application/ld+json' in text, 'head': re.sub(r'\s+', ' ', text[:n])}


# ── пробы ────────────────────────────────────────────────────────────────────
WB_NM = os.environ.get('PROBE_WB_NM', '1099397415')
OZON_URLS = [u for u in os.environ.get('PROBE_OZON', 'https://ozon.ru/t/fBkpTSz').split(',') if u]


async def run_probes():
    await asyncio.sleep(2)
    log('PROBE_START', proxy=bool(RU_PROXY))
    wb_card = f'https://card.wb.ru/cards/v4/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm={WB_NM}'
    wb_int = f'https://www.wildberries.ru/__internal/u-card/cards/v4/detail?appType=1&curr=rub&dest=-1257786&spp=30&ab_testing=false&lang=ru&nm={WB_NM}'
    cases = []
    for ou in OZON_URLS[:1]:
        cases.append(('ozon_page_noproxy', ou, 'chrome', None))
    for name, url, imp, px in cases:
        r = await asyncio.to_thread(cffi_get, url, imp, px)
        s = summarize(r.get('text'))
        extra = {}
        if name.startswith('wb') and r.get('text', '').startswith('{'):
            try:
                j = json.loads(r['text'])
                prods = j.get('products') or j.get('data', {}).get('products') or []
                if prods:
                    p = prods[0]
                    extra = {'name': p.get('name'), 'brand': p.get('brand'),
                             'sizes_price': [sz.get('price') for sz in p.get('sizes', [])][:3]}
            except Exception as e:
                extra = {'json_err': str(e)}
        log('PROBE', case=name, imp=imp, proxy=bool(px), status=r.get('status'), ms=r.get('ms'),
            final=r.get('final_url'), err=r.get('error'), cookies=r.get('cookies'), **s, **extra)
        if s.get('captcha'):
            txt = re.sub(r'\s+', ' ', r.get('text', ''))
            for i in range(0, min(len(txt), 10500), 3500):
                log('PROBE_RAW', part=i, text=txt[i:i + 3500])

    # браузер
    for ou in OZON_URLS:
        try:
            r = await browser_get(ou, wait_selector='[data-widget="webPrice"]', timeout=40)
            log('PROBE', case='ozon_camoufox_direct', status=r.get('first_status'), ms=r.get('ms'),
                final=r.get('final_url'), err=r.get('error'), page_title=r.get('title'), **summarize(r.get('html'), 400))
        except Exception as e:
            log('PROBE', case='ozon_camoufox_ru', err=traceback.format_exc()[-800:])
    try:
        r = await browser_get(f'https://www.wildberries.ru/catalog/{WB_NM}/detail.aspx', wait_selector='ins.price-block__final-price, .price-block__wallet-price')
        log('PROBE', case='wb_camoufox_direct', status=r.get('first_status'), ms=r.get('ms'), final=r.get('final_url'),
            err=r.get('error'), page_title=r.get('title'), **summarize(r.get('html'), 200))
    except Exception:
        log('PROBE', case='wb_camoufox_direct', err=traceback.format_exc()[-800:])
    log('PROBE_END')


# ── HTTP API ─────────────────────────────────────────────────────────────────
async def h_health(req):
    return web.json_response({'ok': True, 'proxy': bool(RU_PROXY), 'browser': _browser is not None})


async def h_fetch(req):
    if not SECRET or req.headers.get('x-fetcher-secret') != SECRET:
        return web.json_response({'error': 'forbidden'}, status=403)
    body = await req.json()
    url, mode = body.get('url'), body.get('mode', 'http')
    if not url or not re.match(r'^https?://', url):
        return web.json_response({'error': 'bad url'}, status=400)
    if mode == 'browser':
        r = await asyncio.wait_for(browser_get(url, body.get('wait_selector'), timeout=int(body.get('timeout', 25))), 60)
        return web.json_response({'status': r.get('first_status'), 'final_url': r.get('final_url'),
                                  'html': r.get('html'), 'ms': r.get('ms'), 'error': r.get('error')})
    px = RU_PROXY if body.get('proxy', True) else None
    r = await asyncio.to_thread(cffi_get, url, body.get('impersonate', 'chrome'), px, body.get('headers'), int(body.get('timeout', 15)))
    return web.json_response({'status': r.get('status'), 'final_url': r.get('final_url'), 'text': r.get('text'),
                              'ms': r.get('ms'), 'error': r.get('error')})


async def on_start(app):
    if os.environ.get('PROBE') == '1':
        asyncio.create_task(run_probes())


def main():
    app = web.Application(client_max_size=2 * 1024 * 1024)
    app.router.add_get('/health', h_health)
    app.router.add_post('/fetch', h_fetch)
    app.on_startup.append(on_start)
    web.run_app(app, host='::', port=PORT)


if __name__ == '__main__':
    main()
