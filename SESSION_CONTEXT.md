# SizeBook — Контекст сессии
_Дата: 21.08.2026_

## Токены и доступы
(хранятся локально, не в git — спросить у владельца)

- **GitHub token**: см. личные сообщения / предыдущий чат
  - Репо: tikhonovjr/sizebook
  - Использование: git remote set-url origin https://TOKEN@github.com/tikhonovjr/sizebook.git

- **Railway token**: см. личные сообщения / предыдущий чат
  - Прод URL: https://desirable-cat-production-6c28.up.railway.app
  - ВАЖНО: backboard.railway.app заблокирован в среде Claude — логи Railway недоступны

- **Firecrawl API key**: хранится в Railway Variables как FIRECRAWL_API_KEY
  - Free план: 1,000 кредитов/месяц

## Что сделали в этой сессии

### 1. Починили фото для 12storeez (коммит e847de4)
- Проблема: Playwright не находил картинку — 12storeez не ставит og:image в HTML, грузит через CDN image.12storeez.com в JS
- Фикс: добавлен fallback в page.evaluate() — поиск по DOM (.ProductMedia img и др.) и regex по image.12storeez.com
- Результат: фото появляется после обновления страницы ✅

### 2. Статус парсера по сайтам
- **12storeez**: title ✅, price ✅, image ✅ (через Playwright + DOM fallback)
- **Wildberries**: ❌ полный геоблок с нероссийских IP. CDN (wbbasket.ru) — 404, card.wb.ru API — закрыт, Firecrawl — тоже блокируется. Решение: РФ прокси-сервис. Проверено перебором basket 01-52 с реального Mac — все 404.
- **Ozon**: добавлен парсер (fetch + API + Firecrawl), не протестирован
- **Farfetch, net-a-porter, matchesfashion, sportmaster**: каскад fetch → Playwright → Firecrawl → jsonlink/iframely

### ⚠️ ПРАВИЛО (не нарушать никогда)
Никогда не предлагать пользователю вводить данные вручную как решение проблемы парсинга. Это противоречит сути продукта — снижение трения. Если парсинг не работает — чинить парсинг.

### 3. UX баг (не исправлен)
- После добавления товара фото видно только после обновления страницы
- Причина: фронтенд не перерисовывает карточку сразу после сохранения
- Нужно: после saveWlItem() вызвать loadWishlist()

## Следующие приоритеты (по роадмапу)

1. **UX: обновление вишлиста без перезагрузки** — фото должно появляться сразу после добавления
2. **Этап 1.1**: Починить сохранение размеров в проде (миграция таблицы sizes)
3. **Этап 1.4**: Строгий auth — невалидный токен → 401, сейчас подставляет id:1

## Инфраструктура

- Репо: https://github.com/tikhonovjr/sizebook
- Прод: https://desirable-cat-production-6c28.up.railway.app
- Фронтенд: sizebook4.html (SPA) + share.html (публичная /s/:token)
- Бэкенд: index.js — Node.js/Express + PostgreSQL + Playwright + Firecrawl
- Последний коммит: 69ba94c (cleanup: remove debug endpoints)
