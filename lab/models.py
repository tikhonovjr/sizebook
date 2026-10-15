"""Открытые нейросети на CPU для тестового набора.

1) Qwen3-VL (2B/4B Instruct): по фото вещи и бирки вернуть JSON — бренд, модель, тип, цвет,
   текст с бирки, поисковый запрос. Замер времени на CPU.
2) Эмбеддинги (Marqo-FashionSigLIP и обычный CLIP): «свой архив» — по фото одной вещи найти
   вторую такую же модель (другое объявление) среди всех фото набора.
"""
import json, os, time, traceback
from PIL import Image

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "out", "models")
os.makedirs(OUT, exist_ok=True)
CASES = json.load(open(os.path.join(HERE, "cases.json")))
COL = os.path.join(HERE, "out", "collect")
WHAT = os.environ.get("WHAT", "embed,qwen").split(",")

PROMPT = (
    "You see photos of one clothing item (whole item and, if present, its label/tag). "
    "Identify it as precisely as possible. Reply ONLY with JSON: "
    '{"brand": str|null, "model": str|null, "category": str, "color": str, '
    '"tag_text": str (all readable text from labels), "codes": [style/article/RN/CA numbers], '
    '"era": str|null, "search_query": str (best web search query to find this exact model), "confidence": 0..1}'
)


def img(case, idx, size=896):
    im = Image.open(os.path.join(COL, case, f"{idx}.jpg")).convert("RGB")
    im.thumbnail((size, size))
    return im


def run_embed():
    import torch, open_clip
    res = {}
    gallery = [(c["id"], c["model"].split()[0] if c["brand"] else "", c) for c in CASES]
    # модель-эталон: бренд+первое слово модели
    key = lambda c: (c["brand"] + " " + c["kw"][0]).lower()
    for name, (arch, pre) in {
        "fashionsiglip": ("hf-hub:Marqo/marqo-fashionSigLIP", None),
        "clip_b32": ("ViT-B-32", "laion2b_s34b_b79k"),
    }.items():
        t = time.time()
        if pre:
            model, _, preprocess = open_clip.create_model_and_transforms(arch, pretrained=pre)
        else:
            model, preprocess, _ = open_clip.create_model_and_transforms(arch)
        model.eval()
        embs = []
        with torch.no_grad():
            for c in CASES:
                x = preprocess(img(c["id"], c["main"], 512)).unsqueeze(0)
                e = model.encode_image(x)
                embs.append(e / e.norm(dim=-1, keepdim=True))
        E = torch.cat(embs)
        S = E @ E.T
        rows, hit1, hit3, n = [], 0, 0, 0
        for i, c in enumerate(CASES):
            same = [j for j, d in enumerate(CASES) if j != i and key(d) == key(c)]
            if not same:
                continue
            order = [j for j in S[i].argsort(descending=True).tolist() if j != i]
            rank = min(order.index(j) for j in same) + 1
            n += 1; hit1 += rank == 1; hit3 += rank <= 3
            rows.append({"case": c["id"], "rank_of_twin": rank, "top3": [CASES[j]["id"] for j in order[:3]]})
        res[name] = {"top1": hit1 / n, "top3": hit3 / n, "n": n, "sec": round(time.time() - t, 1), "rows": rows}
        print(name, res[name]["top1"], res[name]["top3"], flush=True)
    json.dump(res, open(os.path.join(OUT, "embed.json"), "w"), ensure_ascii=False, indent=1)


def run_qwen(model_id):
    import torch
    from transformers import AutoProcessor, AutoModelForImageTextToText
    t0 = time.time()
    proc = AutoProcessor.from_pretrained(model_id, min_pixels=256 * 28 * 28, max_pixels=640 * 28 * 28)
    model = AutoModelForImageTextToText.from_pretrained(model_id, torch_dtype=torch.bfloat16)
    model.eval()
    load = time.time() - t0
    out = {"model": model_id, "load_sec": round(load, 1), "rows": []}
    torch.set_num_threads(os.cpu_count())
    for c in CASES:
        ims = [img(c["id"], c["main"])] + ([img(c["id"], c["tag"])] if c.get("tag") is not None else [])
        content = [{"type": "image", "image": im} for im in ims] + [{"type": "text", "text": PROMPT}]
        msgs = [{"role": "user", "content": content}]
        t = time.time()
        try:
            inputs = proc.apply_chat_template(msgs, tokenize=True, add_generation_prompt=True, return_dict=True, return_tensors="pt")
            with torch.no_grad():
                gen = model.generate(**inputs, max_new_tokens=260, do_sample=False)
            text = proc.batch_decode(gen[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0]
        except Exception as e:
            text = "ERROR " + traceback.format_exc()[-500:]
        row = {"case": c["id"], "sec": round(time.time() - t, 1), "answer": text}
        out["rows"].append(row)
        print(model_id, c["id"], row["sec"], text[:200].replace("\n", " "), flush=True)
        json.dump(out, open(os.path.join(OUT, model_id.split("/")[-1] + ".json"), "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    if "embed" in WHAT:
        try:
            run_embed()
        except Exception:
            traceback.print_exc()
    for m in [x for x in WHAT if "/" in x] or (["Qwen/Qwen3-VL-2B-Instruct", "Qwen/Qwen3-VL-4B-Instruct"] if "qwen" in WHAT else []):
        try:
            run_qwen(m)
        except Exception:
            traceback.print_exc()
