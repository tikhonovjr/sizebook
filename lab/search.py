"""Поиск по картинке для тестового набора: Google Lens, Яндекс Картинки, Bing Visual Search.

Берёт фото из ветки photo-test-results (queries/<id>_main.jpg, отражённые и обрезанные копии),
открывает поиск по ссылке на картинку в headless Chromium и сохраняет найденные ссылки,
текст страницы и скриншот в out/search/<engine>/<id>.*
"""
import json, os, re, time
from urllib.parse import quote, urlparse
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "out", "search")
RAW = "https://raw.githubusercontent.com/tikhonovjr/sizebook/photo-test-results/queries/"
CASES = json.load(open(os.path.join(HERE, "cases.json")))
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
ONLY = os.environ.get("ENGINES", "lens,yandex,bing").split(",")
KINDS = os.environ.get("KINDS", "main").split(",")

ENGINES = {
    "lens": lambda u: "https://lens.google.com/uploadbyurl?hl=en&url=" + quote(u, safe=""),
    "yandex": lambda u: "https://yandex.com/images/search?rpt=imageview&cbir_page=sites&url=" + quote(u, safe=""),
    "bing": lambda u: "https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:" + quote(u, safe=""),
}
SKIP_HOSTS = ("google.", "gstatic.", "yandex.", "ya.ru", "bing.com", "microsoft.", "msn.com", "githubusercontent", "youtube.com/about", "support.", "policies.", "accounts.")


def links(page):
    raw = page.eval_on_selector_all("a[href]", "els => els.map(e => [e.href, (e.innerText||e.getAttribute('aria-label')||'').trim().slice(0,200)])")
    res, seen = [], set()
    for href, text in raw:
        if not href.startswith("http"):
            continue
        h = urlparse(href).netloc
        # Yandex/Google заворачивают ссылки в редиректы — оставляем, но с пометкой хоста
        if any(s in h for s in SKIP_HOSTS) and "url=" not in href:
            continue
        if href in seen or len(text) < 3:
            continue
        seen.add(href)
        res.append({"url": href, "text": text})
    return res


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--disable-blink-features=AutomationControlled"])
        ctx = b.new_context(user_agent=UA, locale="en-US", viewport={"width": 1366, "height": 1000})
        ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
        summary = []
        for eng in ONLY:
            os.makedirs(os.path.join(OUT, eng), exist_ok=True)
            page = ctx.new_page()
            for c in CASES:
                for kind in KINDS:
                    if c.get(kind) is None:
                        continue
                    qid = f"{c['id']}_{kind}"
                    url = ENGINES[eng](RAW + qid + ".jpg")
                    t = time.time()
                    row = {"engine": eng, "case": c["id"], "kind": kind}
                    try:
                        page.goto(url, timeout=60000, wait_until="domcontentloaded")
                        page.wait_for_timeout(6000)
                        for _ in range(2):
                            page.mouse.wheel(0, 2500)
                            page.wait_for_timeout(1200)
                        row["final_url"] = page.url
                        row["title"] = page.title()
                        text = page.inner_text("body")[:20000]
                        row["captcha"] = bool(re.search(r"unusual traffic|not a robot|captcha|я не робот|подтвердите, что запросы", text, re.I))
                        row["links"] = links(page)[:80]
                        open(os.path.join(OUT, eng, qid + ".txt"), "w").write(text)
                        page.screenshot(path=os.path.join(OUT, eng, qid + ".png"), full_page=False)
                    except Exception as e:
                        row["error"] = str(e)[:300]
                    row["ms"] = int((time.time() - t) * 1000)
                    json.dump(row, open(os.path.join(OUT, eng, qid + ".json"), "w"), ensure_ascii=False, indent=1)
                    print(eng, qid, row.get("captcha"), len(row.get("links", [])), row.get("error", ""), flush=True)
                    summary.append({k: row.get(k) for k in ("engine", "case", "kind", "captcha", "ms", "error")})
                    time.sleep(3)
            page.close()
        json.dump(summary, open(os.path.join(OUT, "summary.json"), "w"), ensure_ascii=False, indent=1)
        b.close()


if __name__ == "__main__":
    main()
