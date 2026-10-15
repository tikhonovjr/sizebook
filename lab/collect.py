"""Сбор тестового набора для распознавания по фото.

Для каждой известной модели ищем б/у объявление на eBay: любительские фото
(вещь целиком + бирки) и заголовок объявления как эталон. Фото сохраняем
в out/collect/<id>/, описание — в out/collect/set.json.
"""
import io, json, os, re, sys, time
from urllib.parse import quote_plus
from playwright.sync_api import sync_playwright
import requests
from PIL import Image

ITEMS = json.load(open(os.path.join(os.path.dirname(__file__), "items.json")))
OUT = os.path.join(os.path.dirname(__file__), "out", "collect")
os.makedirs(OUT, exist_ok=True)
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"


def save_img(url, path):
    r = requests.get(url, headers={"User-Agent": UA}, timeout=30)
    r.raise_for_status()
    im = Image.open(io.BytesIO(r.content)).convert("RGB")
    im.thumbnail((1200, 1200))
    im.save(path, "JPEG", quality=88)


def main():
    result = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(user_agent=UA, locale="en-US", viewport={"width": 1366, "height": 900})
        page = ctx.new_page()
        for it in ITEMS:
            q = it["query"]
            url = "https://www.ebay.com/sch/i.html?_nkw=" + quote_plus(q) + "&LH_ItemCondition=3000&_ipg=60"
            row = {**it, "listings": []}
            try:
                page.goto(url, timeout=60000, wait_until="domcontentloaded")
                time.sleep(2)
                links = page.eval_on_selector_all(
                    "a[href*='/itm/']",
                    "els => els.map(e => [e.href, (e.innerText||'').trim()]).filter(x => x[1].length > 15)")
                seen = set()
                cands = []
                for href, title in links:
                    m = re.search(r"/itm/(\d{9,})", href)
                    if not m or m.group(1) in seen:
                        continue
                    seen.add(m.group(1))
                    cands.append((m.group(1), title.split("\n")[0]))
                must = [w.lower() for w in it.get("must", [])]
                cands = [c for c in cands if all(w in c[1].lower() for w in must)]
                print(it["id"], "candidates", len(cands), flush=True)
                for item_id, title in cands[: it.get("take", 2)]:
                    page.goto("https://www.ebay.com/itm/" + item_id, timeout=60000, wait_until="domcontentloaded")
                    time.sleep(2)
                    imgs = page.eval_on_selector_all(
                        "img", "els => els.map(e => e.src || e.getAttribute('data-zoom-src') || '')")
                    ids = []
                    for s in imgs:
                        m = re.search(r"i\.ebayimg\.com/images/g/([^/]+)/", s)
                        if m and m.group(1) not in ids:
                            ids.append(m.group(1))
                    full_title = page.title()
                    d = os.path.join(OUT, f"{it['id']}_{item_id}")
                    os.makedirs(d, exist_ok=True)
                    files = []
                    for n, gid in enumerate(ids[:8]):
                        src = f"https://i.ebayimg.com/images/g/{gid}/s-l1600.jpg"
                        fn = os.path.join(d, f"{n}.jpg")
                        try:
                            save_img(src, fn)
                            files.append({"file": os.path.relpath(fn, OUT), "src": src})
                        except Exception as e:
                            print("img fail", src, e, flush=True)
                    row["listings"].append({"item_id": item_id, "title": full_title, "url": "https://www.ebay.com/itm/" + item_id, "photos": files})
                    print(it["id"], item_id, full_title, len(files), flush=True)
            except Exception as e:
                row["error"] = str(e)[:300]
                print(it["id"], "ERROR", e, flush=True)
            result.append(row)
        b.close()
    json.dump(result, open(os.path.join(OUT, "set.json"), "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
