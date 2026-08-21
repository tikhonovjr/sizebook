# SizeBook — Контекст сессии
_Дата: 21.08.2026_

## Что сделали в этой сессии

### 1. Парсер 12storeez — полностью починен

**Проблема:** Railway IP заблокирован Servicepipe (антибот 12storeez). Прямой fetch возвращает 1743 байта челленджа вместо страницы.

**Решение:** Firecrawl обходит блокировку и возвращает два типа HTML:
- **Короткий (6KB)** — статический TempProductPage без `<head>`, содержит `.ProductSummary__title`, `.ProductSummary__cost`, и URL картинки через regex `image.12storeez.com`
- **Полный (147KB)** — Vue-рендеренная страница, содержит те же классы + JSON-LD

**Что добавили в `parseProductFromHtml`:**
1. Селектор `.ProductSummary__title` → title
2. Селектор `.ProductSummary__cost` → price (с защитой от дублирования ₽)
3. Regex `image.12storeez.com` → image URL, апгрейд до `800xP` качества
4. Блок-фильтр расширен: добавлен `flomni` (чат-виджет даёт мусорный title)

**Каскад для 12storeez:**
- Шаг 1: прямой fetch → Servicepipe блок → null
- Шаг 2: Firecrawl (waitFor:0, timeout:15s) → HTML с данными → парсим

**Параметры Firecrawl:** `waitFor: 0` (убрали 4000ms), `timeout: 15000`

### 2. Чистка названий
- Все названия обрезаются по первой запятой: `"Топ Aurora из кашемира, Цвет: Лиловый..."` → `"Топ Aurora из кашемира"`

### 3. FIRECRAWL_API_KEY — исправлена конфигурация Railway
- Было: ключ `<в Railway Variables как FIRECRAWL_API_KEY>` стоял как **название** переменной, значение было пустым
- Стало: `FIRECRAWL_API_KEY` = `<в Railway Variables как FIRECRAWL_API_KEY>`

## Коммиты сессии
- `21b9771` — fix(parser): 12storeez merge playwright+firecrawl, clean title
- `1809d0b` — temp: add /debug-parse endpoint (удалён)
- `990065c` — fix(parser): firecrawl waitFor:4000 for Vue SPA
- `a7c6eed` — temp: debug-parse show firecrawl parsed result (удалён)
- `9112bb3` — temp: debug firecrawl og tags (удалён)
- `39910b4` — fix(parser): 12storeez use direct fetch, firecrawl as fallback
- `22c8e42` — fix(parser): extract from window._site.data.product
- `21f5f03` — fix(parser): parse ProductSummary__title/cost/image
- `e2c95e6` — fix(parser): 12storeez complete v1, remove debug
- `88456a5` — perf(parser): firecrawl remove waitFor:4000, timeout 15s
- `f2b6e6a` — fix(parser): image regex fallback, upgrade to 800xP
- `a5d542d` — fix(parser): 12storeez complete, remove debug ✅

## Статус парсеров на 21.08.2026
| Сайт | Статус | Метод |
|---|---|---|
| 12storeez | ✅ работает | Firecrawl → ProductSummary селекторы + image regex |
| Wildberries | ⚠️ title+image OK, цена нет | CDN wbbasket.ru (цена заблокирована с датацентр. IP) |
| Zara | ✅ | direct fetch + __NEXT_DATA__ |
| Спортмастер | ✅ добавлен в BOT_PROTECTED | fetch → Playwright → Firecrawl → jsonlink/iframely |
| Farfetch | ⚠️ нестабильно | BOT_PROTECTED каскад |
| net-a-porter | ⚠️ нестабильно | BOT_PROTECTED каскад |

## Следующие приоритеты

### Быстрые wins (парсер)
- **Кеш парсинга** — хранить результат в БД по URL, повторный запрос мгновенный
- WB цена — нужен РФ прокси или российский хостинг для микросервиса

### Этап 1 (критические хвосты — всё ещё не закрыты!)
- **1.1** Миграция таблицы `sizes` (реальная схема != код, лишняя колонка `category`)
- **1.2** Smoke-test сохранения размеров на проде
- **1.3** Ротация секретов (JWT_SECRET и Postgres пароль светились в чатах)
- **1.4** Строгий auth (`authenticateToken` подставляет `id:1` даже при невалидном токене)
- **1.5** Убрать декоративные чекбоксы приватности

## Инфраструктура (актуально)
- Прод: https://desirable-cat-production-6c28.up.railway.app
- Репо: https://github.com/tikhonovjr/sizebook
- GitHub токен: <в Railway Variables / 1Password> (активный, права repo)
- Railway токен: <в Railway Settings → Tokens>
- Railway: автодеплой из git push в main
- FIRECRAWL_API_KEY: <в Railway Variables как FIRECRAWL_API_KEY> (в Railway Variables)
- Free план Firecrawl: 1000 кредитов/месяц (1 кредит = 1 страница)
