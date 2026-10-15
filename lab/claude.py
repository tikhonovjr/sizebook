"""Замер Claude (Haiku / Sonnet) на тестовом наборе через боевой /lab/vision.

Варианты: фото вещи + бирка (Haiku, Sonnet) и только фото вещи (Haiku).
Результаты — out/claude/results.json.
"""
import json, os, time, urllib.request

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "out", "claude")
os.makedirs(OUT, exist_ok=True)
CASES = json.load(open(os.path.join(HERE, "cases.json")))
BASE = "https://desirable-cat-production-6c28.up.railway.app"
RAW = "https://raw.githubusercontent.com/tikhonovjr/sizebook/photo-test-results/vision/"
PROMPT = (
    "You see photos of one clothing item (whole item and, if present, its label/tag). "
    "Identify it as precisely as possible. Reply ONLY with JSON: "
    '{"brand": str|null, "model": str|null, "category": str, "color": str, "size": str|null, '
    '"tag_text": str (all readable text from labels), "codes": [style/article/RN/CA numbers], '
    '"era": str|null, "search_query": str (best web search query to find this exact model), "confidence": 0..1}'
)
RUNS = [("claude-haiku-5-5", True), ("claude-sonnet-5-5", True), ("claude-haiku-5-5", False)]


def call(model, images):
    req = urllib.request.Request(BASE + "/lab/vision", data=json.dumps({"model": model, "images": images, "prompt": PROMPT}).encode(),
                                 headers={"Content-Type": "application/json", "X-CI-Key": os.environ.get("CI_KEY", "")})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {"error": f"http {e.code} {e.read()[:200]!r}"}
    except Exception as e:
        return {"error": str(e)[:200]}


res = []
for model, with_tag in RUNS:
    for c in CASES:
        imgs = [RAW + c["id"] + "_main.jpg"] + ([RAW + c["id"] + "_tag.jpg"] if with_tag and c.get("tag") is not None else [])
        t = time.time()
        r = call(model, imgs)
        row = {"model": model, "with_tag": with_tag, "case": c["id"], "wall_ms": int((time.time() - t) * 1000), **r}
        res.append(row)
        print(model, with_tag, c["id"], row.get("ms"), (row.get("text") or row.get("error") or "")[:220].replace("\n", " "), flush=True)
        json.dump(res, open(os.path.join(OUT, "results.json"), "w"), ensure_ascii=False, indent=1)
