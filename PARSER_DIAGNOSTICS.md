# SizeBook — Диагностика парсинга (журнал замеров)
_Создано 08.10.2026. Назначение: чтобы результаты экспериментов были под рукой в новых сессиях. Токены сюда не писать._

## 1. Главные выводы
- Причина медленного парсинга: Firecrawl с `proxy: auto` сначала пробует слабый прокси и повторяет сильным (скрытая задержка); `waitFor` — слепой sleep; серийный каскад direct → Playwright → Firecrawl → jsonlink → iframely.
- Кэш Firecrawl (`maxAge`, по умолчанию 2 дня) даёт ~0,3 с на повторы.
- Wildberries: страница требует ≥4,5–6 с рендера в Firecrawl; JSON-эндпоинты WB через Firecrawl RU отдают заглушку. Через Scrape.do `super=1&geoCode=ru` — 1,4–3 с, 10 кредитов.
- Превью-боты мессенджеров (UA `WhatsApp/2.23.20.0 A`, TelegramBot, facebookexternalhit) открывают часть магазинов с датацентровых IP (SSENSE, ASOS, Яндекс Маркет, 12storeez). Это серая зона (подмена UA) — использовано только для tier `wa`; Ozon и Sportmaster так не открываются.
- Scrape.do (бесплатный тариф 1000 кредитов): без `super` на WB/Farfetch — ошибка ROTATION_FAILED после ~57 с; Ozon.ru закрыт для бесплатных пакетов (400); Sportmaster 401 на любом режиме; `render=true` не нужен там, где есть JSON-LD/og.
- Стоимость в кредитах Scrape.do: plain=1, render=5, super=10, render+super=25. Заголовки ответа: `scrape.do-request-cost`, `scrape.do-remaining-credits`.

## 2. Реализованная архитектура (коммиты a274570, затем fix)
Файл `index.js`: `HOST_STRATEGY` (магазин → порядок источников), `parseByStrategy`, `parseViaScrapedo`, `fetchViaScrapedo`, `fetchParse` (direct / WA-UA), кэш `PARSE_CACHE` (час) + дедупликация `PARSE_INFLIGHT`, фон `enrichWishlistItem` (сохранить сразу, статус `parse_status` pending/done/failed).
Tiers: `direct`, `wa` (UA превью-бота), `direct+wa` (параллельно), `sd` (Scrape.do super; geo=ru для .ru), затем Firecrawl и jsonlink как запасной вариант. `noFallback: true` для закрытых антиботом (sportmaster.ru, tsum.ru, ru.puma.com) — быстрый отказ.
Лимит Scrape.do: `SCRAPEDO_DAILY_LIMIT` (по умолчанию 300 запросов/сутки, in-memory).
Особые ветки без изменений: 12storeez (direct → Firecrawl), Wildberries (basket CDN + цена через Scrape.do RU → Firecrawl RU), Ozon (`parseOzon`, всё ещё пусто).

## 3. Тестовые ссылки (08.10.2026, собраны поиском; часть могла устареть)
- wildberries.ru: https://www.wildberries.ru/catalog/176566362/detail.aspx
- ozon.ru: https://www.ozon.ru/product/krossovki-nike-2292301192/
- lamoda.ru: https://www.lamoda.ru/p/rtladq279101/shoes-newbalance-krossovki/
- market.yandex.ru: https://market.yandex.ru/product--futbolka-ivcapriz/1098415872?sku=102252020555&uniqueId=69979524
- sportmaster.ru: https://www.sportmaster.ru/product/39936790299/
- aliexpress.ru: https://aliexpress.ru/item/1005005582450490.html
- gloria-jeans.ru: https://www.gloria-jeans.ru/product/GJN037497-1/Serye-pramye-dzinsy
- befree.ru: https://befree.ru/zhenskaya/product/BF2441414019/50
- sela.ru: https://www.sela.ru/eshop/men/dzhempery/dzhempery/5802110635_2/
- 12storeez.com: https://12storeez.com/catalog/plata/womencollection/plate-iz-shelka-126639
- brandshop.ru: https://brandshop.ru/goods/494666/mr530adc/
- street-beat.ru: https://street-beat.ru/d/krossovki-street-beat-snkm10024-100/
- tsum.ru: https://www.tsum.ru/product/6405687-khlopkovye-boksery-tom-ford-temno-seryi/
- detmir.ru: https://www.detmir.ru/product/index/id/6197460/
- kupivip.ru: https://kupivip.ru/product/plate-patrizia-pepe-85888-zheltyy/
- ru.puma.com: https://ru.puma.com/puma-r78-373117-01.html
- bask.ru: https://bask.ru/catalog/kurtka-bask-taimyr-v3-19h08/
- farfetch.com: https://www.farfetch.com/shopping/women/swear-element-sneakers-item-14612856.aspx
- asos.com: https://www.asos.com/us/asos-design/asos-design-essentials-muscle-fit-t-shirt-in-black/prd/203291724
- hm.com: https://www2.hm.com/en_us/productpage.1227157019.html
- uniqlo.com: https://www.uniqlo.com/us/en/products/E470067-000/00
- net-a-porter.com: https://www.net-a-porter.com/en-us/shop/product/anine-bing/clothing/midi-dresses/chloe-silk-satin-maxi-dress/1647597311244139
- ssense.com: https://www.ssense.com/en-us/men/product/nike/gray-dunk-low-sneakers/11885161
- nike.com: https://www.nike.com/t/air-force-1-07-mens-shoes-DZejrQoC
- amazon.com: https://www.amazon.com/True-Classic-Mens-T-Shirts-Novelty/dp/B0FNN4R5H6

## 4. Итог покрытия через боевой `/parse` (повторный прогон после правок)
| Магазин | Нашли (t=название p=цена i=картинка) | Время | Название | Цена |
|---|---|---|---|---|
| wildberries.ru | ti | 2140 мс | Кроссовки мужские высокие  зимние утепле |  |
| ozon.ru | -- | 261 мс |  |  |
| lamoda.ru | tpi | 3179 мс | New Balance Кроссовки 1000 | 12499 RUB |
| market.yandex.ru | tpi | 8915 мс | Футболка | 834 RUB |
| sportmaster.ru | -- | 10489 мс |  |  |
| aliexpress.ru | ti | 7582 мс | Футболка East-1 Cosmonaut из полиэстера  |  |
| gloria-jeans.ru | t | 19785 мс | Omnibox Commands |  |
| befree.ru | tpi | 1709 мс | Платье миди облегающее из сетки с пайетк | 499 RUB |
| sela.ru | tpi | 14317 мс | Страница не найдена | 3 999 ₽ |
| 12storeez.com | tpi | 1569 мс | Платье из шелка | 9 800 ₽ |
| brandshop.ru | tpi | 1141 мс | Мужские кроссовки New Balance MR530ADC,  | 9940 RUB |
| street-beat.ru | tpi | 1817 мс | Мужские кроссовки District 2 | 3199 RUB |
| tsum.ru | -- | 10619 мс |  |  |
| detmir.ru | tpi | 2108 мс | Куртка Reima цвет розовый 5100084A-4230  | 9 546 ₽ |
| kupivip.ru | tpi | 3255 мс | Купить платье PATRIZIA PEPE 8A1061K9J5,  | 45 900 ₽ |
| ru.puma.com | -- | 1008 мс |  |  |
| bask.ru | tpi | 3205 мс | TAIMYR V4 ЧЕРНЫЙ | 66300 RUB |
| farfetch.com | t | 2136 мс | FARFETCH - The Global Destination For Mo |  |
| asos.com | ti | 4305 мс | ASOS DESIGN essentials muscle fit T-shir |  |
| hm.com | tpi | 4861 мс | Men’s Black/New York Loose Fit Printed T | $8.99 |
| uniqlo.com | t | 17433 мс | UNIQLO homeUNIQLO home |  |
| net-a-porter.com | t | 4728 мс | NET-A-PORTER | Not Found | Designer fash |  |
| ssense.com | tpi | 992 мс | Silver & Black Shox BB4 Sneakers | 185 USD |
| nike.com | tpi | 568 мс | Nike Air Force 1 '07 Men's Shoes | $115 |
| amazon.com | tp | 7855 мс | True Classic Mens T | $69.99 |

Выводы: полные данные — Lamoda, Яндекс Маркет, Befree, 12storeez, Brandshop, Street Beat, Детский мир, KupiVIP, Bask, H&M, SSENSE, Nike. Частично — WB, AliExpress, ASOS (нет цены), Amazon (нет картинки), Gloria Jeans (заглушка). Закрыты — Ozon, Sportmaster, ЦУМ, Puma.ru. Заглушки на Farfetch/Uniqlo/Net-a-Porter/Sela — вероятно мёртвые тестовые ссылки (Farfetch ранее работал на `salomon-xt-6-item-33433630`).

**ЦУМ (tsum.ru):** владелец помнит, что в самом начале проекта ЦУМ работал лучше всех. Записей об этом в репозитории нет (в `git log -S tsum` до 08.10.2026 пусто). Текущая тестовая ссылка (`6405687-khlopkovye-boksery-tom-ford…`) даёт `fetch failed` с Railway и 502 у Scrape.do — нужны 1–2 реальные ссылки ЦУМ от владельца и перепроверка (в т. ч. Playwright/Firecrawl, `tsum.ru` стоит в `noFallback`, проверить и снять).

## 5. Как перезапустить замеры
1. Railway → сервис `desirable-cat` → Variables: `ENABLE_DEBUG=1` (по окончании вернуть `0`). Проект `powerful-fulfillment`, env `production`.
2. GitHub Actions workflows (запуск через API `repos/tikhonovjr/sizebook/actions/workflows/<файл>/dispatches`, ref=main; песочница Claude не достаёт до Railway-домена, GitHub-раннеры достают): `probe-speed.yml`, `probe-speed2.yml` (Firecrawl-режимы), `probe-sd.yml` (Scrape.do режимы), `probe-coverage.yml` (chrome / wa / sd по 24 ссылкам), `parse-coverage.yml` (боевой `/parse` по 24 ссылкам; debug не нужен), `smoke.yml` (read-only смоук).
3. Результаты каждый workflow пушит в сиротскую ветку (`probe-results`, `probe-sd`, `probe-cov`, `probe-cov2`); копии лежат в `diagnostics/` в репозитории.
4. Debug-эндпоинты (за `ENABLE_DEBUG`): `/debug/fcspeed` (Firecrawl с параметрами wf, loc, fmt, maxAge, proxy, raw), `/debug/uaprobe?ua=chrome|tg|fb|google|wa|tw|slack`, `/debug/sdprobe?super=1&geo=ru&render=1`, `/debug/fcprobe`, `/debug/smprobe`, `/debug/smproxy`, `/debug/proxy-check`.

## 6. Прочие файлы с историческими замерами (в репозитории)
`test_results.json`, `deep_probe.json`, `probe_12storeez.json`, `12storeez_links.json`, `proxy_check.json`, `sm_live.json`, `wb_live.json`, `PARSER_CONTEXT.md`.

## 7. Сырые данные


### Firecrawl: режимы прокси, waitFor, WB эндпоинты (раунд 1)
`diagnostics/speed_results.json`
```json
{
  "started": "2026-10-08T10:15:00Z",
  "firecrawl": {
    "ff_wf4000_nocache": {
      "wall_ms": 8623,
      "sent": {
        "formats": [
          "rawHtml"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 4000,
        "maxAge": 0
      },
      "http": 200,
      "ms": 7989,
      "html_len": 388697,
      "meta_status": 200,
      "meta_title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
      "cache": null,
      "title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
      "price": "192.00 GBP",
      "image": true
    },
    "ff_wf0_nocache": {
      "wall_ms": 8912,
      "sent": {
        "formats": [
          "rawHtml"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 0,
        "maxAge": 0
      },
      "http": 200,
      "ms": 8402,
      "html_len": 207555,
      "meta_status": 200,
      "meta_title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
      "cache": null,
      "title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
      "price": "192.00 GBP",
      "image": true
    },
    "ff_wf1500_nocache": {
      "wall_ms": 7473,
      "sent": {
        "formats": [
          "rawHtml"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 1500,
        "maxAge": 0
      },
      "http": 200,
      "ms": 6959,
      "html_len": 367785,
      "meta_status": 200,
      "meta_title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
      "cache": null,
      "title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
      "price": "192.00 GBP",
      "image": true
    },
    "ff_wf2500_nocache": {
      "wall_ms": 6857,
      "sent": {
        "formats": [
          "rawHtml"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 2500,
        "maxAge": 0
      },
      "http": 200,
      "ms": 6292,
      "html_len": 390151,
      "meta_status": 200,
      "meta_title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
      "cache": null,
      "title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
      "price": "192.00 GBP",
      "image": true
    },
    "ff_wf4000_cache_a": {
      "wall_ms": 884,
      "sent": {
        "formats": [
          "rawHtml"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 4000
      },
      "http": 200,
      "ms": 320,
      "html_len": 388697,
      "meta_status": 200,
      "meta_title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
      "cache": "hit",
      "title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
      "price": "192.00 GBP",
      "image": true
    },
    "ff_wf4000_cache_b": {
      "wall_ms": 877,
      "sent": {
        "formats": [
          "rawHtml"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 4000
      },
      "http": 200,
      "ms": 329,
      "html_len": 388697,
      "meta_status": 200,
      "meta_title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
      "cache": "hit",
      "title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
      "price": "192.00 GBP",
      "image": true
    },
    "wb_page_wf6000_RU": {
      "wall_ms": 8529,
      "sent": {
        "formats": [
          "rawHtml"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 6000,
        "location": {
          "country": "RU"
        },
        "maxAge": 0
      },
      "http": 200,
      "ms": 7651,
      "html_len": 2095406,
      "meta_status": 200,
      "meta_title": "Интернет‑магазин Wildberries: широкий ассортимент товаров - ",
      "cache": null,
      "title": "Интернет‑магазин Wildberries: широкий ассортимент товаров - ",
      "price": null,
      "image": true
    },
    "wb_page_wf1500_RU": {
      "wall_ms": 3237,
      "sent": {
        "formats": [
          "rawHtml"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 1500,
        "location": {
          "country": "RU"
        },
        "maxAge": 0
      },
      "http": 200,
      "ms": 3004,
      "html_len": 1801,
      "meta_status": 498,
      "meta_title": "...",
      "cache": null,
      "title": "...",
      "price": null,
      "image": false
    },
    "wb_page_wf0_RU": {
      "wall_ms": 2151,
      "sent": {
        "formats": [
          "rawHtml"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 0,
        "location": {
          "country": "RU"
        },
        "maxAge": 0
      },
      "http": 200,
      "ms": 1928,
      "html_len": 1662,
      "meta_status": 498,
      "meta_title": "...",
      "cache": null,
      "title": "...",
      "price": null,
      "image": false
    },
    "wb_json_v2_RU": {
      "wall_ms": 1471,
      "sent": {
        "formats": [
          "rawHtml"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 0,
        "location": {
          "country": "RU"
        },
        "maxAge": 0
      },
      "http": 200,
      "ms": 1267,
      "html_len": 321,
      "meta_status": 403,
      "meta_title": null,
      "cache": null,
      "title": null,
      "price": null,
      "image": false,
      "raw": "<html><head><meta http-equiv=\"Content-Type\" content=\"text/html; charset=windows-1252\"><meta name=\"color-scheme\" content=\"light dark\"></head><body><pre style=\"word-wrap: break-word; white-space: pre-wrap;\">&lt;!doctype html&gt;&lt;html&gt;&lt;head&gt;&lt;/head&gt;&lt;body&gt;&lt;/body&gt;&lt;/html&gt;</pre></body></html>"
    },
    "wb_json_v1_RU": {
      "wall_ms": 1501,
      "sent": {
        "formats": [
          "rawHtml"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 0,
        "location": {
          "country": "RU"
        },
        "maxAge": 0
      },
      "http": 200,
      "ms": 1270,
      "html_len": 321,
      "meta_status": 403,
      "meta_title": null,
      "cache": null,
      "title": null,
      "price": null,
      "image": false,
      "raw": "<html><head><meta http-equiv=\"Content-Type\" content=\"text/html; charset=windows-1252\"><meta name=\"color-scheme\" content=\"light dark\"></head><body><pre style=\"word-wrap: break-word; white-space: pre-wrap;\">&lt;!doctype html&gt;&lt;html&gt;&lt;head&gt;&lt;/head&gt;&lt;body&gt;&lt;/body&gt;&lt;/html&gt;</pre></body></html>"
    },
    "wb_json_v2_noloc": {
      "wall_ms": 3481,
      "sent": {
        "formats": [
          "rawHtml"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 0,
        "maxAge": 0
      },
      "http": 200,
      "ms": 3226,
      "html_len": 321,
      "meta_status": 403,
      "meta_title": null,
      "cache": null,
      "title": null,
      "price": null,
      "image": false,
      "raw": "<html><head><meta http-equiv=\"Content-Type\" content=\"text/html; charset=windows-1252\"><meta name=\"color-scheme\" content=\"light dark\"></head><body><pre style=\"word-wrap: break-word; white-space: pre-wrap;\">&lt;!doctype html&gt;&lt;html&gt;&lt;head&gt;&lt;/head&gt;&lt;body&gt;&lt;/body&gt;&lt;/html&gt;</pre></body></html>"
    }
  },
  "ua": {
    "farfetch": {
      "chrome": {
        "wall_ms": 305,
        "ua": "chrome",
        "status": 403,
        "ms": 59,
        "html_len": 451,
        "json_ld": false,
        "og_title": false,
        "title": null,
        "price": null,
        "image": false
      },
      "tg": {
        "wall_ms": 275,
        "ua": "tg",
        "status": 403,
        "ms": 66,
        "html_len": 451,
        "json_ld": false,
        "og_title": false,
        "title": null,
        "price": null,
        "image": false
      },
      "fb": {
        "wall_ms": 236,
        "ua": "fb",
        "status": 403,
        "ms": 29,
        "html_len": 451,
        "json_ld": false,
        "og_title": false,
        "title": null,
        "price": null,
        "image": false
      },
      "google": {
        "wall_ms": 256,
        "ua": "google",
        "status": 403,
        "ms": 36,
        "html_len": 451,
        "json_ld": false,
        "og_title": false,
        "title": null,
        "price": null,
        "image": false
      },
      "wa": {
        "wall_ms": 323,
        "ua": "wa",
        "status": 403,
        "ms": 113,
        "html_len": 607,
        "json_ld": false,
        "og_title": false,
        "title": null,
        "price": null,
        "image": false
      }
    },
    "wb_page": {
      "chrome": {
        "wall_ms": 754,
        "ua": "chrome",
        "status": 498,
        "ms": 540,
        "html_len": 1134,
        "json_ld": false,
        "og_title": false,
        "title": "...",
        "price": null,
        "image": false
      },
      "tg": {
        "wall_ms": 381,
        "ua": "tg",
        "status": 498,
        "ms": 178,
        "html_len": 1134,
        "json_ld": false,
        "og_title": false,
        "title": "...",
        "price": null,
        "image": false
      },
      "fb": {
        "wall_ms": 383,
        "ua": "fb",
        "status": 498,
        "ms": 175,
        "html_len": 1134,
        "json_ld": false,
        "og_title": false,
        "title": "...",
        "price": null,
        "image": false
      },
      "google": {
        "wall_ms": 376,
        "ua": "google",
        "status": 498,
        "ms": 176,
        "html_len": 1134,
        "json_ld": false,
        "og_title": false,
        "title": "...",
        "price": null,
        "image": false
      },
      "wa": {
        "wall_ms": 363,
        "ua": "wa",
        "status": 498,
        "ms": 175,
        "html_len": 1134,
        "json_ld": false,
        "og_title": false,
        "title": "...",
        "price": null,
        "image": false
      }
    },
    "ozon": {
      "chrome": {
        "wall_ms": 4647,
        "ua": "chrome",
        "error": "fetch failed",
        "ms": 4466
      },
      "tg": {
        "wall_ms": 3978,
        "ua": "tg",
        "error": "fetch failed",
        "ms": 3750
      },
      "fb": {
        "wall_ms": 3974,
        "ua": "fb",
        "error": "fetch failed",
        "ms": 3764
      },
      "google": {
        "wall_ms": 3954,
        "ua": "google",
        "error": "fetch failed",
        "ms": 3746
      },
      "wa": {
        "wall_ms": 1433,
        "ua": "wa",
        "status": 200,
        "ms": 1205,
        "html_len": 1588877,
        "json_ld": true,
        "og_title": true,
        "title": "Носки мужские мужские, 5 пар",
        "price": "705 RUB",
        "image": true
      }
    },
    "sportmaster_home": {
      "chrome": {
        "wall_ms": 1425,
        "ua": "chrome",
        "status": 401,
        "ms": 1205,
        "html_len": 10673,
        "json_ld": false,
        "og_title": false,
        "title": "Спортмастер",
        "price": null,
        "image": false
      },
      "tg": {
        "wall_ms": 3203,
        "ua": "tg",
        "status": 200,
        "ms": 2923,
        "html_len": 1631711,
        "json_ld": true,
        "og_title": true,
        "title": "Спортмастер — спортивный магазин для всей семьи!",
        "price": null,
        "image": true
      },
      "fb": {
        "wall_ms": 211,
        "ua": "fb",
        "status": 401,
        "ms": 7,
        "html_len": 10673,
        "json_ld": false,
        "og_title": false,
        "title": "Спортмастер",
        "price": null,
        "image": false
      },
      "google": {
        "wall_ms": 209,
        "ua": "google",
        "status": 401,
        "ms": 7,
        "html_len": 10673,
        "json_ld": false,
        "og_title": false,
        "title": "Спортмастер",
        "price": null,
        "image": false
      },
      "wa": {
        "wall_ms": 3004,
        "ua": "wa",
        "status": 200,
        "ms": 2788,
        "html_len": 1631685,
        "json_ld": true,
        "og_title": true,
        "title": "Спортмастер — спортивный магазин для всей семьи!",
        "price": null,
        "image": true
      }
    },
    "12storeez_home": {
      "chrome": {
        "wall_ms": 848,
        "ua": "chrome",
        "status": 200,
        "ms": 623,
        "html_len": 1771,
        "json_ld": false,
        "og_title": false,
        "title": null,
        "price": null,
        "image": false
      },
      "tg": {
        "wall_ms": 842,
        "ua": "tg",
        "status": 200,
        "ms": 619,
        "html_len": 80379,
        "json_ld": true,
        "og_title": false,
        "title": "12 STOREEZ — Интернет",
        "price": null,
        "image": true
      },
      "fb": {
        "wall_ms": 703,
        "ua": "fb",
        "status": 200,
        "ms": 494,
        "html_len": 80378,
        "json_ld": true,
        "og_title": false,
        "title": "12 STOREEZ — Интернет",
        "price": null,
        "image": true
      },
      "google": {
        "wall_ms": 354,
        "ua": "google",
        "status": 200,
        "ms": 141,
        "html_len": 1772,
        "json_ld": false,
        "og_title": false,
        "title": null,
        "price": null,
        "image": false
      },
      "wa": {
        "wall_ms": 351,
        "ua": "wa",
        "status": 200,
        "ms": 141,
        "html_len": 1772,
        "json_ld": false,
        "og_title": false,
        "title": null,
        "price": null,
        "image": false
      }
    }
  }
}
```


### Firecrawl: Farfetch proxy, WB waitFor, UA-тесты Ozon/Sportmaster (раунд 2)
`diagnostics/speed2_results.json`
```json
{
  "started": "2026-10-08T10:31:08Z",
  "firecrawl": {
    "ff_proxy_basic_wf0": {
      "wall_ms": 7605,
      "sent": {
        "formats": [
          "rawHtml"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 0,
        "maxAge": 0,
        "proxy": "basic"
      },
      "http": 200,
      "ms": 6917,
      "html_len": 583380,
      "meta_status": 200,
      "meta_title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
      "cache": null,
      "title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
      "price": "192.00 GBP",
      "image": true
    },
    "ff_proxy_stealth_wf0": {
      "wall_ms": 4675,
      "sent": {
        "formats": [
          "rawHtml"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 0,
        "maxAge": 0,
        "proxy": "stealth"
      },
      "http": 200,
      "ms": 4133,
      "html_len": 238071,
      "meta_status": 200,
      "meta_title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
      "cache": null,
      "title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
      "price": "192.00 GBP",
      "image": true
    },
    "ff_proxy_enh_wf0": {
      "wall_ms": 3559,
      "sent": {
        "formats": [
          "rawHtml"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 0,
        "maxAge": 0,
        "proxy": "enhanced"
      },
      "http": 200,
      "ms": 3069,
      "html_len": 236548,
      "meta_status": 200,
      "meta_title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
      "cache": null,
      "title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
      "price": "192.00 GBP",
      "image": true
    },
    "wb_html_wf3000_RU": {
      "wall_ms": 4923,
      "sent": {
        "formats": [
          "html"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 3000,
        "location": {
          "country": "RU"
        },
        "maxAge": 0
      },
      "http": 200,
      "ms": 4706,
      "html_len": 4922,
      "meta_status": 200,
      "meta_title": "Интернет‑магазин Wildberries: широкий ассортимент товаров - ",
      "cache": null,
      "title": null,
      "price": null,
      "image": false
    },
    "wb_html_wf4500_RU": {
      "wall_ms": 6603,
      "sent": {
        "formats": [
          "html"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 4500,
        "location": {
          "country": "RU"
        },
        "maxAge": 0
      },
      "http": 200,
      "ms": 6188,
      "html_len": 115359,
      "meta_status": 200,
      "meta_title": "Интернет‑магазин Wildberries: широкий ассортимент товаров - ",
      "cache": null,
      "title": null,
      "price": null,
      "image": false
    },
    "wb_html_wf6000_RU": {
      "wall_ms": 8396,
      "sent": {
        "formats": [
          "html"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 6000,
        "location": {
          "country": "RU"
        },
        "maxAge": 0
      },
      "http": 200,
      "ms": 7983,
      "html_len": 99586,
      "meta_status": 200,
      "meta_title": "Интернет‑магазин Wildberries: широкий ассортимент товаров - ",
      "cache": null,
      "title": null,
      "price": null,
      "image": false
    },
    "wb_v4_internal_RU": {
      "wall_ms": 1145,
      "sent": {
        "formats": [
          "rawHtml"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 0,
        "location": {
          "country": "RU"
        },
        "maxAge": 0
      },
      "http": 200,
      "ms": 936,
      "html_len": 321,
      "meta_status": 403,
      "meta_title": null,
      "cache": null,
      "title": null,
      "price": null,
      "image": false,
      "raw": "<html><head><meta http-equiv=\"Content-Type\" content=\"text/html; charset=windows-1252\"><meta name=\"color-scheme\" content=\"light dark\"></head><body><pre style=\"word-wrap: break-word; white-space: pre-wrap;\">&lt;!doctype html&gt;&lt;html&gt;&lt;head&gt;&lt;/head&gt;&lt;body&gt;&lt;/body&gt;&lt;/html&gt;</pre></body></html>"
    },
    "wb_ucard_v4_RU": {
      "wall_ms": 1397,
      "sent": {
        "formats": [
          "rawHtml"
        ],
        "onlyMainContent": false,
        "timeout": 30000,
        "waitFor": 0,
        "location": {
          "country": "RU"
        },
        "maxAge": 0
      },
      "http": 200,
      "ms": 1193,
      "html_len": 321,
      "meta_status": 403,
      "meta_title": null,
      "cache": null,
      "title": null,
      "price": null,
      "image": false,
      "raw": "<html><head><meta http-equiv=\"Content-Type\" content=\"text/html; charset=windows-1252\"><meta name=\"color-scheme\" content=\"light dark\"></head><body><pre style=\"word-wrap: break-word; white-space: pre-wrap;\">&lt;!doctype html&gt;&lt;html&gt;&lt;head&gt;&lt;/head&gt;&lt;body&gt;&lt;/body&gt;&lt;/html&gt;</pre></body></html>"
    }
  },
  "stability": {
    "ozon": {
      "chrome_1": {
        "wall_ms": 4613,
        "ua": "chrome",
        "error": "fetch failed",
        "ms": 4411
      },
      "tg_1": {
        "wall_ms": 3904,
        "ua": "tg",
        "error": "fetch failed",
        "ms": 3683
      },
      "wa_1": {
        "wall_ms": 1447,
        "ua": "wa",
        "status": 200,
        "ms": 1240,
        "html_len": 1588029,
        "json_ld": true,
        "og_title": true,
        "title": "Носки мужские мужские, 5 пар",
        "price": "705 RUB",
        "image": true
      },
      "wa_2": {
        "wall_ms": 849,
        "ua": "wa",
        "status": 200,
        "ms": 615,
        "html_len": 1587996,
        "json_ld": true,
        "og_title": true,
        "title": "Носки мужские мужские, 5 пар",
        "price": "705 RUB",
        "image": true
      },
      "wa_3": {
        "wall_ms": 627,
        "ua": "wa",
        "status": 200,
        "ms": 446,
        "html_len": 1588022,
        "json_ld": true,
        "og_title": true,
        "title": "Носки мужские мужские, 5 пар",
        "price": "705 RUB",
        "image": true
      }
    },
    "sm_product_1": {
      "chrome_1": {
        "wall_ms": 232,
        "ua": "chrome",
        "status": 401,
        "ms": 27,
        "html_len": 10673,
        "json_ld": false,
        "og_title": false,
        "title": "Спортмастер",
        "price": null,
        "image": false
      },
      "tg_1": {
        "wall_ms": 5339,
        "ua": "tg",
        "status": 200,
        "ms": 5138,
        "html_len": 1689417,
        "json_ld": false,
        "og_title": true,
        "title": "Кроссовки мужские Kappa Authentic Run арт. 128809 болотный цвет — купи",
        "price": "7499 RUB",
        "image": true
      },
      "wa_1": {
        "wall_ms": 4645,
        "ua": "wa",
        "status": 200,
        "ms": 4453,
        "html_len": 1650788,
        "json_ld": false,
        "og_title": true,
        "title": "Кроссовки мужские Kappa Authentic Run арт. 128809 болотный цвет — купи",
        "price": "7499 RUB",
        "image": true
      },
      "wa_2": {
        "wall_ms": 4766,
        "ua": "wa",
        "status": 200,
        "ms": 4537,
        "html_len": 1683386,
        "json_ld": false,
        "og_title": true,
        "title": "Кроссовки мужские Kappa Authentic Run арт. 128809 болотный цвет — купи",
        "price": "7499 RUB",
        "image": true
      },
      "wa_3": {
        "wall_ms": 5057,
        "ua": "wa",
        "status": 200,
        "ms": 4852,
        "html_len": 1653528,
        "json_ld": false,
        "og_title": true,
        "title": "Кроссовки мужские Kappa Authentic Run арт. 128809 болотный цвет — купи",
        "price": "7499 RUB",
        "image": true
      }
    },
    "sm_product_2": {
      "chrome_1": {
        "wall_ms": 206,
        "ua": "chrome",
        "status": 401,
        "ms": 10,
        "html_len": 10673,
        "json_ld": false,
        "og_title": false,
        "title": "Спортмастер",
        "price": null,
        "image": false
      },
      "tg_1": {
        "wall_ms": 3886,
        "ua": "tg",
        "status": 200,
        "ms": 3670,
        "html_len": 1638131,
        "json_ld": false,
        "og_title": true,
        "title": "Кроссовки мужские PUMA Replicatch арт. 405096 черный/белый цвет — купи",
        "price": "4999 RUB",
        "image": true
      },
      "wa_1": {
        "wall_ms": 3612,
        "ua": "wa",
        "status": 200,
        "ms": 3385,
        "html_len": 1672382,
        "json_ld": false,
        "og_title": true,
        "title": "Кроссовки мужские PUMA Replicatch арт. 405096 черный/белый цвет — купи",
        "price": "4999 RUB",
        "image": true
      },
      "wa_2": {
        "wall_ms": 3600,
        "ua": "wa",
        "status": 200,
        "ms": 3407,
        "html_len": 1672370,
        "json_ld": false,
        "og_title": true,
        "title": "Кроссовки мужские PUMA Replicatch арт. 405096 черный/белый цвет — купи",
        "price": "4999 RUB",
        "image": true
      },
      "wa_3": {
        "wall_ms": 3702,
        "ua": "wa",
        "status": 200,
        "ms": 3499,
        "html_len": 1640155,
        "json_ld": false,
        "og_title": true,
        "title": "Кроссовки мужские PUMA Replicatch арт. 405096 черный/белый цвет — купи",
        "price": "4999 RUB",
        "image": true
      }
    }
  },
  "coverage": {
    "lamoda": {
      "listing": "https://www.lamoda.ru/c/17/shoes-men/",
      "note": "listing fetch error: HTTP Error 403: Forbidden"
    },
    "zara": {
      "listing": "https://www.zara.com/es/en/man-shirts-l737.html",
      "note": "no product link found (len=2226)"
    },
    "hm": {
      "listing": "https://www2.hm.com/en_gb/men/shop-by-product/t-shirts-and-tanks.html",
      "note": "listing fetch error: HTTP Error 403: Forbidden"
    },
    "uniqlo": {
      "listing": "https://www.uniqlo.com/eu-pl/en/men/tops",
      "note": "listing fetch error: HTTP Error 403: Forbidden"
    },
    "mytheresa": {
      "listing": "https://www.mytheresa.com/gb/en/men/shoes/sneakers",
      "note": "no product link found (len=9834)"
    },
    "asos": {
      "listing": "https://www.asos.com/men/shoes-boots-trainers/cat/?cid=4209",
      "product_url": "https://www.asos.com/new-balance/new-balance-530-unisex-trainers-in-off-white-and-beige/prd/204936689#colourWayId-204936690",
      "chrome": {
        "wall_ms": 1183,
        "ua": "chrome",
        "status": 200,
        "ms": 980,
        "html_len": 574456,
        "json_ld": true,
        "og_title": true,
        "title": "New Balance 530 unisex trainers in off white and beige",
        "price": null,
        "image": true
      },
      "tg": {
        "wall_ms": 12223,
        "ua": "tg",
        "error": "The operation was aborted due to timeout",
        "ms": 12002
      }
    },
    "nike": {
      "listing": "https://www.nike.com/w/mens-shoes-nik1zy7ok",
      "product_url": "https://www.nike.com/t/air-jordan-1-high-og-royal-mens-shoes-p8vLeLAd/IQ5495-005",
      "chrome": {
        "wall_ms": 1056,
        "ua": "chrome",
        "status": 200,
        "ms": 843,
        "html_len": 735004,
        "json_ld": true,
        "og_title": true,
        "title": "Air Jordan 1 High OG \"Royal\" Men's Shoes",
        "price": "$185",
        "image": true
      },
      "tg": {
        "wall_ms": 223,
        "ua": "tg",
        "status": 403,
        "ms": 22,
        "html_len": 469,
        "json_ld": false,
        "og_title": false,
        "title": null,
        "price": null,
        "image": false
      }
    },
    "adidas": {
      "listing": "https://www.adidas.com/us/men-shoes",
      "note": "listing fetch error: HTTP Error 403: Forbidden"
    },
    "netaporter": {
      "listing": "https://www.net-a-porter.com/en-gb/shop/clothing",
      "note": "listing fetch error: HTTP Error 403: Forbidden"
    },
    "12storeez": {
      "listing": "https://12storeez.com/catalog/",
      "note": "listing fetch error: HTTP Error 404: Not Found"
    },
    "aliexpress": {
      "listing": "https://www.aliexpress.com/w/wholesale-sneakers.html",
      "note": "no product link found (len=907571)"
    }
  }
}
```


### Scrape.do: 5 магазинов × 4 режима
`diagnostics/sd_results.json`
```json
{
 "wb": {
  "plain": {
   "wall_ms": 58707,
   "http": 502,
   "ms": 58440,
   "cost": "0",
   "remaining": "999",
   "html_len": 442,
   "title": null,
   "price": null,
   "image": false,
   "head": "{\"URL\":\"https://www.wildberries.ru/catalog/1510075000/detail.aspx\",\"StatusCode\":502,\"ErrorCode\":90,\"ErrorType\":\"ROTATION_FAILED\",\"Message\":[\"Error: not returnin"
  },
  "render": {
   "wall_ms": 57385,
   "http": 502,
   "ms": 57177,
   "cost": "0",
   "remaining": "995",
   "html_len": 435,
   "title": null,
   "price": null,
   "image": false,
   "head": "{\"URL\":\"https://www.wildberries.ru/catalog/1510075000/detail.aspx\",\"StatusCode\":502,\"ErrorCode\":90,\"ErrorType\":\"ROTATION_FAILED\",\"Message\":[\"Error: unexpected n"
  },
  "super_ru": {
   "wall_ms": 3202,
   "http": 200,
   "ms": 2944,
   "cost": "10",
   "remaining": "990",
   "html_len": 71959,
   "title": "Треккинговые кроссовки мужские демисезонные, PATROL",
   "price": "3206 RUB",
   "image": true
  },
  "render_super_ru": {
   "wall_ms": 57396,
   "http": 502,
   "ms": 57192,
   "cost": "0",
   "remaining": "965",
   "html_len": 461,
   "title": null,
   "price": null,
   "image": false,
   "head": "{\"URL\":\"https://www.wildberries.ru/catalog/1510075000/detail.aspx\",\"StatusCode\":502,\"ErrorCode\":90,\"ErrorType\":\"ROTATION_FAILED\",\"Message\":[\"Error: unexpected n"
  }
 },
 "ozon": {
  "plain": {
   "wall_ms": 478,
   "http": 400,
   "ms": 239,
   "cost": null,
   "remaining": null,
   "html_len": 514,
   "title": null,
   "price": null,
   "image": false,
   "head": "{\"URL\":\"https://www.ozon.ru/product/noski-muzhskie-muzhskie-5-par-3148849655/\",\"StatusCode\":400,\"Message\":[\"We disabled the target domain for free packages. Ple"
  },
  "render": {
   "wall_ms": 408,
   "http": 400,
   "ms": 206,
   "cost": null,
   "remaining": null,
   "html_len": 514,
   "title": null,
   "price": null,
   "image": false,
   "head": "{\"URL\":\"https://www.ozon.ru/product/noski-muzhskie-muzhskie-5-par-3148849655/\",\"StatusCode\":400,\"Message\":[\"We disabled the target domain for free packages. Ple"
  },
  "super_ru": {
   "wall_ms": 402,
   "http": 400,
   "ms": 196,
   "cost": null,
   "remaining": null,
   "html_len": 514,
   "title": null,
   "price": null,
   "image": false,
   "head": "{\"URL\":\"https://www.ozon.ru/product/noski-muzhskie-muzhskie-5-par-3148849655/\",\"StatusCode\":400,\"Message\":[\"We disabled the target domain for free packages. Ple"
  },
  "render_super_ru": {
   "wall_ms": 465,
   "http": 400,
   "ms": 180,
   "cost": null,
   "remaining": null,
   "html_len": 514,
   "title": null,
   "price": null,
   "image": false,
   "head": "{\"URL\":\"https://www.ozon.ru/product/noski-muzhskie-muzhskie-5-par-3148849655/\",\"StatusCode\":400,\"Message\":[\"We disabled the target domain for free packages. Ple"
  }
 },
 "sm": {
  "plain": {
   "wall_ms": 8105,
   "http": 401,
   "ms": 7891,
   "cost": "1",
   "remaining": "989",
   "html_len": 10673,
   "title": "Спортмастер",
   "price": null,
   "image": false
  },
  "render": {
   "wall_ms": 37165,
   "http": 401,
   "ms": 36935,
   "cost": "5",
   "remaining": "984",
   "html_len": 10665,
   "title": "Спортмастер",
   "price": null,
   "image": false
  },
  "super_ru": {
   "wall_ms": 844,
   "http": 401,
   "ms": 618,
   "cost": "10",
   "remaining": "974",
   "html_len": 10673,
   "title": "Спортмастер",
   "price": null,
   "image": false
  },
  "render_super_ru": {
   "wall_ms": 46773,
   "http": 401,
   "ms": 46564,
   "cost": "25",
   "remaining": "949",
   "html_len": 10665,
   "title": "Спортмастер",
   "price": null,
   "image": false
  }
 },
 "ff": {
  "plain": {
   "wall_ms": 57418,
   "http": 502,
   "ms": 57182,
   "cost": "0",
   "remaining": "948",
   "html_len": 448,
   "title": null,
   "price": null,
   "image": false,
   "head": "{\"URL\":\"https://www.farfetch.com/uk/shopping/women/salomon-xt-6-item-33433630.aspx\",\"StatusCode\":502,\"ErrorCode\":90,\"ErrorType\":\"ROTATION_FAILED\",\"Message\":[\"Er"
  },
  "render": {
   "wall_ms": 57405,
   "http": 502,
   "ms": 57180,
   "cost": "0",
   "remaining": "948",
   "html_len": 448,
   "title": null,
   "price": null,
   "image": false,
   "head": "{\"URL\":\"https://www.farfetch.com/uk/shopping/women/salomon-xt-6-item-33433630.aspx\",\"StatusCode\":502,\"ErrorCode\":90,\"ErrorType\":\"ROTATION_FAILED\",\"Message\":[\"Er"
  },
  "super_ru": {
   "wall_ms": 2889,
   "http": 200,
   "ms": 2580,
   "cost": "10",
   "remaining": "939",
   "html_len": 542079,
   "title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
   "price": "192.00 GBP",
   "image": true
  },
  "render_super_ru": {
   "wall_ms": 3900,
   "http": 200,
   "ms": 3653,
   "cost": "10",
   "remaining": "929",
   "html_len": 542542,
   "title": "Salomon XT-6 Sneakers | White | FARFETCH UK",
   "price": "192.00 GBP",
   "image": true
  }
 },
 "12s": {
  "plain": {
   "wall_ms": 673,
   "http": 200,
   "ms": 451,
   "cost": "1",
   "remaining": "928",
   "html_len": 1772,
   "title": null,
   "price": null,
   "image": false,
   "head": "<!DOCTYPE html> <html> <head> <meta http-equiv=\"Content-Type\" content=\"text/html; charset=UTF-8\"> <noscript><meta http-equiv=\"refresh\" content=\"0; url=/exhk"
  },
  "render": {
   "wall_ms": 5312,
   "http": 200,
   "ms": 5098,
   "cost": "5",
   "remaining": "923",
   "html_len": 1773,
   "title": null,
   "price": null,
   "image": false,
   "head": "<!DOCTYPE html><html><head> <meta http-equiv=\"Content-Type\" content=\"text/html; charset=UTF-8\"> <noscript><meta http-equiv=\"refresh\" content=\"0; url=/exhkqy"
  },
  "super_ru": {
   "wall_ms": 2121,
   "http": 200,
   "ms": 1772,
   "cost": "10",
   "remaining": "913",
   "html_len": 1772,
   "title": null,
   "price": null,
   "image": false,
   "head": "<!DOCTYPE html> <html> <head> <meta http-equiv=\"Content-Type\" content=\"text/html; charset=UTF-8\"> <noscript><meta http-equiv=\"refresh\" content=\"0; url=/exhk"
  },
  "render_super_ru": {
   "wall_ms": 6931,
   "http": 200,
   "ms": 6714,
   "cost": "25",
   "remaining": "888",
   "html_len": 1773,
   "title": null,
   "price": null,
   "image": false,
   "head": "<!DOCTYPE html><html><head> <meta http-equiv=\"Content-Type\" content=\"text/html; charset=UTF-8\"> <noscript><meta http-equiv=\"refresh\" content=\"0; url=/exhkqy"
  }
 }
}
```


### Покрытие: chrome vs WhatsApp-UA vs Scrape.do super (24 ссылки)
`diagnostics/coverage_results.json`
```json
{
 "wildberries.ru": {
  "url": "https://www.wildberries.ru/catalog/176566362/detail.aspx",
  "chrome": {
   "status": 498,
   "ms": 622,
   "title": "...",
   "image": false
  },
  "wa": {
   "status": 498,
   "ms": 201,
   "title": "...",
   "image": false
  },
  "sd_super": {
   "http": 200,
   "ms": 1390,
   "cost": "10",
   "title": "Кроссовки мужские высокие  зимние утепленные Merrell, MERREL",
   "image": true
  }
 },
 "ozon.ru": {
  "url": "https://www.ozon.ru/product/krossovki-nike-2292301192/",
  "chrome": {
   "ms": 5321,
   "error": "fetch failed"
  },
  "wa": {
   "status": 403,
   "ms": 216,
   "image": false
  },
  "sd_super": {
   "http": 400,
   "ms": 196,
   "image": false,
   "head": "{\"URL\":\"https://www.ozon.ru/product/krossovki-nike-2292301192/\",\"StatusCode\":400,\"Message\":[\"We disabled the target domain for free packages. Please upgrade you"
  }
 },
 "lamoda.ru": {
  "url": "https://www.lamoda.ru/p/rtladq279101/shoes-newbalance-krossovki/",
  "chrome": {
   "status": 403,
   "ms": 1660,
   "title": "Запрос отклонен",
   "image": false
  },
  "wa": {
   "status": 403,
   "ms": 153,
   "title": "Запрос отклонен",
   "image": false
  },
  "sd_super": {
   "http": 200,
   "ms": 8352,
   "cost": "10",
   "title": "New Balance Кроссовки 1000",
   "price": "12499 RUB",
   "image": true
  }
 },
 "market.yandex.ru": {
  "url": "https://market.yandex.ru/product--futbolka-ivcapriz/1098415872?sku=102252020555&uniqueId=69979524",
  "chrome": {
   "status": 200,
   "ms": 1286,
   "title": "Yandex",
   "image": true
  },
  "wa": {
   "status": 200,
   "ms": 486,
   "title": "Yandex",
   "image": true
  },
  "sd_super": {
   "http": 200,
   "ms": 6481,
   "cost": "10",
   "title": "Футболка",
   "price": "834 RUB",
   "image": true
  }
 },
 "sportmaster.ru": {
  "url": "https://www.sportmaster.ru/product/39936790299/",
  "chrome": {
   "ms": 10194,
   "error": "fetch failed"
  },
  "wa": {
   "ms": 10365,
   "error": "fetch failed"
  },
  "sd_super": {
   "http": 502,
   "ms": 57193,
   "cost": "0",
   "image": false,
   "head": "{\"URL\":\"https://www.sportmaster.ru/product/39936790299/\",\"StatusCode\":502,\"ErrorCode\":90,\"ErrorType\":\"ROTATION_FAILED\",\"Message\":[\"Error: failed to make request"
  }
 },
 "aliexpress.ru": {
  "url": "https://aliexpress.ru/item/1005005582450490.html",
  "chrome": {
   "status": 200,
   "ms": 2024,
   "image": false
  },
  "wa": {
   "status": 200,
   "ms": 255,
   "image": false
  },
  "sd_super": {
   "http": 200,
   "ms": 3451,
   "cost": "10",
   "title": "Футболка East-1 Cosmonaut из полиэстера на AliExpress",
   "image": true
  }
 },
 "gloria-jeans.ru": {
  "url": "https://www.gloria-jeans.ru/product/GJN037497-1/Serye-pramye-dzinsy",
  "chrome": {
   "status": 200,
   "ms": 639,
   "image": false
  },
  "wa": {
   "status": 200,
   "ms": 148,
   "image": false
  },
  "sd_super": {
   "http": 200,
   "ms": 633,
   "cost": "10",
   "title": "Сайт Gloria Jeans",
   "image": false
  }
 },
 "befree.ru": {
  "url": "https://befree.ru/zhenskaya/product/BF2441414019/50",
  "chrome": {
   "status": 200,
   "ms": 1488,
   "title": "Платье миди облегающее из сетки с пайетками",
   "price": "499 RUB",
   "image": true
  },
  "wa": {
   "status": 200,
   "ms": 757,
   "title": "Платье миди облегающее из сетки с пайетками",
   "price": "499 RUB",
   "image": true
  },
  "sd_super": {
   "http": 200,
   "ms": 1769,
   "cost": "10",
   "title": "Платье миди облегающее из сетки с пайетками",
   "price": "499 RUB",
   "image": true
  }
 },
 "sela.ru": {
  "url": "https://www.sela.ru/eshop/men/dzhempery/dzhempery/5802110635_2/",
  "chrome": {
   "status": 404,
   "ms": 1667,
   "title": "Страница не найдена",
   "image": true
  },
  "wa": {
   "status": 404,
   "ms": 689,
   "title": "Страница не найдена",
   "image": true
  },
  "sd_super": {
   "http": 404,
   "ms": 2423,
   "cost": "10",
   "title": "Страница не найдена",
   "image": true
  }
 },
 "12storeez.com": {
  "url": "https://12storeez.com/catalog/plata/womencollection/plate-iz-shelka-126639",
  "chrome": {
   "status": 200,
   "ms": 668,
   "image": false
  },
  "wa": {
   "status": 200,
   "ms": 153,
   "image": false
  },
  "sd_super": {
   "http": 200,
   "ms": 2068,
   "cost": "10",
   "title": "Платье из шелка",
   "price": "9800.00 RUB",
   "image": true
  }
 },
 "brandshop.ru": {
  "url": "https://brandshop.ru/goods/494666/mr530adc/",
  "chrome": {
   "status": 200,
   "ms": 889,
   "title": "Мужские кроссовки New Balance MR530ADC, MR530ADC",
   "price": "9940 RUB",
   "image": true
  },
  "wa": {
   "status": 200,
   "ms": 655,
   "title": "Мужские кроссовки New Balance MR530ADC, MR530ADC",
   "price": "9940 RUB",
   "image": true
  },
  "sd_super": {
   "http": 200,
   "ms": 1343,
   "cost": "10",
   "title": "Мужские кроссовки New Balance MR530ADC, MR530ADC",
   "price": "9940 RUB",
   "image": true
  }
 },
 "street-beat.ru": {
  "url": "https://street-beat.ru/d/krossovki-street-beat-snkm10024-100/",
  "chrome": {
   "status": 200,
   "ms": 2611,
   "title": "Мужские кроссовки District 2",
   "price": "3199 RUB",
   "image": true
  },
  "wa": {
   "status": 200,
   "ms": 642,
   "title": "Мужские кроссовки District 2",
   "price": "3199 RUB",
   "image": true
  },
  "sd_super": {
   "http": 200,
   "ms": 3261,
   "cost": "10",
   "title": "Мужские кроссовки District 2",
   "price": "3199 RUB",
   "image": true
  }
 },
 "tsum.ru": {
  "url": "https://www.tsum.ru/product/6405687-khlopkovye-boksery-tom-ford-temno-seryi/",
  "chrome": {
   "ms": 10407,
   "error": "fetch failed"
  },
  "wa": {
   "ms": 10353,
   "error": "fetch failed"
  },
  "sd_super": {
   "http": 502,
   "ms": 57522,
   "cost": "0",
   "image": false,
   "head": "{\"URL\":\"https://www.tsum.ru/product/6405687-khlopkovye-boksery-tom-ford-temno-seryi/\",\"StatusCode\":502,\"ErrorCode\":90,\"ErrorType\":\"ROTATION_FAILED\",\"Message\":[\""
  }
 },
 "detmir.ru": {
  "url": "https://www.detmir.ru/product/index/id/6197460/",
  "chrome": {
   "status": 200,
   "ms": 2355,
   "title": "Куртка Reima цвет розовый 5100084A-4230 купить по цене 12729 ₽ в интер",
   "price": "9 546 ₽",
   "image": true
  },
  "wa": {
   "status": 200,
   "ms": 2782,
   "title": "Куртка Reima цвет розовый 5100084A-4230 купить по цене 12729 ₽ в интер",
   "price": "9 546 ₽",
   "image": true
  },
  "sd_super": {
   "http": 200,
   "ms": 6327,
   "cost": "10",
   "title": "Куртка Reima цвет розовый 5100084A-4230 купить по цене 12729",
   "price": "9 546 ₽",
   "image": true
  }
 },
 "kupivip.ru": {
  "url": "https://kupivip.ru/product/plate-patrizia-pepe-85888-zheltyy/",
  "chrome": {
   "ms": 12002,
   "error": "The operation was aborted due to timeout"
  },
  "wa": {
   "ms": 12001,
   "error": "The operation was aborted due to timeout"
  },
  "sd_super": {
   "http": 200,
   "ms": 2016,
   "cost": "10",
   "title": "Купить платье PATRIZIA PEPE 8A1061K9J5, цвет Желтый для женщ",
   "price": "45 900 ₽",
   "image": true
  }
 },
 "ru.puma.com": {
  "url": "https://ru.puma.com/puma-r78-373117-01.html",
  "chrome": {
   "status": 503,
   "ms": 242,
   "title": "PUMA",
   "image": false
  },
  "wa": {
   "status": 503,
   "ms": 199,
   "title": "PUMA",
   "image": false
  },
  "sd_super": {
   "http": 502,
   "ms": 57182,
   "cost": "0",
   "image": false,
   "head": "{\"URL\":\"https://ru.puma.com/puma-r78-373117-01.html\",\"StatusCode\":502,\"ErrorCode\":90,\"ErrorType\":\"ROTATION_FAILED\",\"Message\":[\"Error: cannot connect target url\""
  }
 },
 "bask.ru": {
  "url": "https://bask.ru/catalog/kurtka-bask-taimyr-v3-19h08/",
  "chrome": {
   "status": 200,
   "ms": 2955,
   "title": "TAIMYR V4 ЧЕРНЫЙ",
   "price": "66300 RUB",
   "image": true
  },
  "wa": {
   "status": 200,
   "ms": 2122,
   "title": "TAIMYR V4 ЧЕРНЫЙ",
   "price": "66300 RUB",
   "image": true
  },
  "sd_super": {
   "http": 200,
   "ms": 2719,
   "cost": "10",
   "title": "TAIMYR V4 ЧЕРНЫЙ",
   "price": "66300 RUB",
   "image": true
  }
 },
 "farfetch.com": {
  "url": "https://www.farfetch.com/shopping/women/swear-element-sneakers-item-14612856.aspx",
  "chrome": {
   "status": 403,
   "ms": 34,
   "image": false
  },
  "wa": {
   "status": 403,
   "ms": 57,
   "image": false
  },
  "sd_super": {
   "http": 410,
   "ms": 1394,
   "cost": "10",
   "title": "FARFETCH",
   "image": false
  }
 },
 "asos.com": {
  "url": "https://www.asos.com/us/asos-design/asos-design-essentials-muscle-fit-t-shirt-in-black/prd/203291724",
  "chrome": {
   "ms": 12001,
   "error": "The operation was aborted due to timeout"
  },
  "wa": {
   "status": 200,
   "ms": 999,
   "title": "ASOS DESIGN essentials muscle fit T-shirt in black | ASOS",
   "image": true
  },
  "sd_super": {
   "http": 200,
   "ms": 3230,
   "cost": "10",
   "title": "ASOS DESIGN essentials muscle fit T-shirt in black | ASOS",
   "image": true
  }
 },
 "hm.com": {
  "url": "https://www2.hm.com/en_us/productpage.1227157019.html",
  "chrome": {
   "status": 403,
   "ms": 41,
   "image": false
  },
  "wa": {
   "status": 403,
   "ms": 240,
   "image": false
  },
  "sd_super": {
   "http": 200,
   "ms": 7467,
   "cost": "10",
   "title": "Men’s Black/New York Loose Fit Printed T-shirt | H&M US",
   "price": "$8.99",
   "image": true
  }
 },
 "uniqlo.com": {
  "url": "https://www.uniqlo.com/us/en/products/E470067-000/00",
  "chrome": {
   "status": 404,
   "ms": 519,
   "title": "UNIQLO",
   "image": false
  },
  "wa": {
   "status": 404,
   "ms": 382,
   "title": "UNIQLO",
   "image": false
  },
  "sd_super": {
   "http": 404,
   "ms": 3185,
   "cost": "10",
   "title": "UNIQLO",
   "image": false
  }
 },
 "net-a-porter.com": {
  "url": "https://www.net-a-porter.com/en-us/shop/product/anine-bing/clothing/midi-dresses/chloe-silk-satin-maxi-dress/1647597311244139",
  "chrome": {
   "status": 403,
   "ms": 35,
   "image": false
  },
  "wa": {
   "status": 403,
   "ms": 87,
   "image": false
  },
  "sd_super": {
   "http": 404,
   "ms": 3322,
   "cost": "10"
  }
 },
 "ssense.com": {
  "url": "https://www.ssense.com/en-us/men/product/nike/gray-dunk-low-sneakers/11885161",
  "chrome": {
   "status": 403,
   "ms": 33,
   "image": false
  },
  "wa": {
   "status": 200,
   "ms": 999,
   "title": "Silver & Black Shox BB4 Sneakers",
   "price": "185 USD",
   "image": true
  },
  "sd_super": {
   "http": 200,
   "ms": 3349,
   "cost": "10",
   "title": "Silver & Black Shox BB4 Sneakers",
   "price": "185 USD",
   "image": true
  }
 },
 "nike.com": {
  "url": "https://www.nike.com/t/air-force-1-07-mens-shoes-DZejrQoC",
  "chrome": {
   "status": 200,
   "ms": 602,
   "title": "Nike Air Force 1 '07 Men's Shoes",
   "price": "$115",
   "image": true
  },
  "wa": {
   "status": 200,
   "ms": 158,
   "title": "Nike Air Force 1 '07 Men's Shoes",
   "price": "$115",
   "image": true
  },
  "sd_super": {
   "http": 200,
   "ms": 1400,
   "cost": "10",
   "title": "Nike Air Force 1 '07 Men's Shoes",
   "price": "$115",
   "image": true
  }
 },
 "amazon.com": {
  "url": "https://www.amazon.com/True-Classic-Mens-T-Shirts-Novelty/dp/B0FNN4R5H6",
  "chrome": {
   "status": 200,
   "ms": 2021,
   "title": "True Classic Mens T",
   "price": "$69.99",
   "image": false
  },
  "wa": {
   "status": 200,
   "ms": 1781,
   "title": "True Classic Mens T-Shirts, Short Sleeve Crew Neck T Shirts for Men | ",
   "image": true
  },
  "sd_super": {
   "http": 200,
   "ms": 3183,
   "cost": "10",
   "title": "True Classic Mens T",
   "price": "$69.99",
   "image": false
  }
 }
}
```


### Боевой /parse по 24 ссылкам (после правок)
`diagnostics/parse_coverage.json`
```json
{
 "wildberries.ru": {
  "wall_ms": 2140,
  "title": "Кроссовки мужские высокие  зимние утепленные Merre",
  "price": null,
  "image": true,
  "steps": [
   "wildberries:done"
  ],
  "error": null
 },
 "ozon.ru": {
  "wall_ms": 261,
  "title": "",
  "price": null,
  "image": false,
  "steps": [
   "ozon:done"
  ],
  "error": null
 },
 "lamoda.ru": {
  "wall_ms": 3179,
  "title": "New Balance Кроссовки 1000",
  "price": "12499 RUB",
  "image": true,
  "steps": [
   "tier:sd",
   "done"
  ],
  "error": null
 },
 "market.yandex.ru": {
  "wall_ms": 8915,
  "title": "Футболка",
  "price": "834 RUB",
  "image": true,
  "steps": [
   "tier:direct",
   "tier:sd",
   "done"
  ],
  "error": null
 },
 "sportmaster.ru": {
  "wall_ms": 10489,
  "title": "",
  "price": null,
  "image": false,
  "steps": [
   "tier:direct+wa",
   "done"
  ],
  "error": null
 },
 "aliexpress.ru": {
  "wall_ms": 7582,
  "title": "Футболка East-1 Cosmonaut из полиэстера на AliExpr",
  "price": null,
  "image": true,
  "steps": [
   "tier:sd",
   "done"
  ],
  "error": null
 },
 "gloria-jeans.ru": {
  "wall_ms": 19785,
  "title": "Omnibox Commands",
  "price": null,
  "image": false,
  "steps": [
   "tier:direct",
   "tier:sd",
   "tier:firecrawl",
   "tier:jsonlink",
   "done"
  ],
  "error": null
 },
 "befree.ru": {
  "wall_ms": 1709,
  "title": "Платье миди облегающее из сетки с пайетками",
  "price": "499 RUB",
  "image": true,
  "steps": [
   "tier:direct",
   "done"
  ],
  "error": null
 },
 "sela.ru": {
  "wall_ms": 14317,
  "title": "Страница не найдена",
  "price": "3 999 ₽",
  "image": true,
  "steps": [
   "tier:direct+wa",
   "tier:sd",
   "tier:firecrawl",
   "done"
  ],
  "error": null
 },
 "12storeez.com": {
  "wall_ms": 1569,
  "title": "Платье из шелка",
  "price": "9 800 ₽",
  "image": true,
  "steps": [
   "12storeez:direct-fetch",
   "12storeez:firecrawl"
  ],
  "error": null
 },
 "brandshop.ru": {
  "wall_ms": 1141,
  "title": "Мужские кроссовки New Balance MR530ADC, MR530ADC",
  "price": "9940 RUB",
  "image": true,
  "steps": [
   "tier:direct",
   "done"
  ],
  "error": null
 },
 "street-beat.ru": {
  "wall_ms": 1817,
  "title": "Мужские кроссовки District 2",
  "price": "3199 RUB",
  "image": true,
  "steps": [
   "tier:direct",
   "done"
  ],
  "error": null
 },
 "tsum.ru": {
  "wall_ms": 10619,
  "title": "",
  "price": null,
  "image": false,
  "steps": [
   "tier:direct+wa",
   "done"
  ],
  "error": null
 },
 "detmir.ru": {
  "wall_ms": 2108,
  "title": "Куртка Reima цвет розовый 5100084A-4230 купить по ",
  "price": "9 546 ₽",
  "image": true,
  "steps": [
   "tier:direct",
   "done"
  ],
  "error": null
 },
 "kupivip.ru": {
  "wall_ms": 3255,
  "title": "Купить платье PATRIZIA PEPE 8A1061K9J5, цвет Желты",
  "price": "45 900 ₽",
  "image": true,
  "steps": [
   "tier:sd",
   "done"
  ],
  "error": null
 },
 "ru.puma.com": {
  "wall_ms": 1008,
  "title": "",
  "price": null,
  "image": false,
  "steps": [
   "tier:direct+wa",
   "done"
  ],
  "error": null
 },
 "bask.ru": {
  "wall_ms": 3205,
  "title": "TAIMYR V4 ЧЕРНЫЙ",
  "price": "66300 RUB",
  "image": true,
  "steps": [
   "tier:direct",
   "done"
  ],
  "error": null
 },
 "farfetch.com": {
  "wall_ms": 2136,
  "title": "FARFETCH - The Global Destination For Modern Luxur",
  "price": null,
  "image": false,
  "steps": [
   "tier:sd",
   "tier:firecrawl",
   "tier:jsonlink",
   "done"
  ],
  "error": null
 },
 "asos.com": {
  "wall_ms": 4305,
  "title": "ASOS DESIGN essentials muscle fit T-shirt in black",
  "price": null,
  "image": true,
  "steps": [
   "tier:wa",
   "tier:sd",
   "done"
  ],
  "error": null
 },
 "hm.com": {
  "wall_ms": 4861,
  "title": "Men’s Black/New York Loose Fit Printed T-shirt | H",
  "price": "$8.99",
  "image": true,
  "steps": [
   "tier:sd",
   "done"
  ],
  "error": null
 },
 "uniqlo.com": {
  "wall_ms": 17433,
  "title": "UNIQLO homeUNIQLO home",
  "price": null,
  "image": false,
  "steps": [
   "tier:direct",
   "tier:sd",
   "tier:firecrawl",
   "tier:jsonlink",
   "done"
  ],
  "error": null
 },
 "net-a-porter.com": {
  "wall_ms": 4728,
  "title": "NET-A-PORTER | Not Found | Designer fashion for wo",
  "price": null,
  "image": false,
  "steps": [
   "tier:sd",
   "tier:firecrawl",
   "tier:jsonlink",
   "done"
  ],
  "error": null
 },
 "ssense.com": {
  "wall_ms": 992,
  "title": "Silver & Black Shox BB4 Sneakers",
  "price": "185 USD",
  "image": true,
  "steps": [
   "tier:wa",
   "done"
  ],
  "error": null
 },
 "nike.com": {
  "wall_ms": 568,
  "title": "Nike Air Force 1 '07 Men's Shoes",
  "price": "$115",
  "image": true,
  "steps": [
   "tier:direct",
   "done"
  ],
  "error": null
 },
 "amazon.com": {
  "wall_ms": 7855,
  "title": "True Classic Mens T",
  "price": "$69.99",
  "image": false,
  "steps": [
   "tier:direct",
   "tier:sd",
   "tier:jsonlink",
   "done"
  ],
  "error": null
 }
}
```
