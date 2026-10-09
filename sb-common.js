/* SizeBook: общий код для приложения (/passport) и страницы для друзей (/s/:token).
   Цены в валюте оригинала с пересчётом в рубли, бренд и короткое русское название товара. */
// ── Цены: валюта оригинала + рубли по курсу ЦБ ──
let RATES = null;
const CUR_RE = [[/byn|бел\.?\s?руб/i, 'BYN'], [/₽|руб|\brub\b|(?:^|\s|\d)р\.?(?=\s|$)/i, 'RUB'], [/us\$|\$|\busd\b/i, 'USD'], [/€|\beur\b|евро/i, 'EUR'], [/£|\bgbp\b/i, 'GBP'], [/₸|\bkzt\b|тенге|тг\.?$/i, 'KZT'], [/\bcny\b|юан|\brmb\b/i, 'CNY'], [/¥|\bjpy\b|иен/i, 'JPY'], [/₺|\btry\b|лир/i, 'TRY'], [/\baed\b|дирх/i, 'AED'], [/\bchf\b/i, 'CHF'], [/₩|\bkrw\b/i, 'KRW'], [/₴|\buah\b|грн/i, 'UAH'], [/\bamd\b|драм|֏/i, 'AMD'], [/\bgel\b|лари|₾/i, 'GEL']];
const CUR_SYM = { RUB: ['', ' ₽'], USD: ['$', ''], EUR: ['€', ''], GBP: ['£', ''], JPY: ['¥', ''], CNY: ['', ' ¥'], KZT: ['', ' ₸'], TRY: ['', ' ₺'], BYN: ['', ' BYN'], UAH: ['', ' ₴'], KRW: ['₩', ''], AED: ['', ' AED'], CHF: ['', ' CHF'], AMD: ['', ' ֏'], GEL: ['', ' ₾'] };
function parseAmount(t) {
  const m = String(t).replace(/ | /g, ' ').match(/\d[\d\s.,']*/); if (!m) return NaN;
  let x = m[0].replace(/[\s']/g, '').replace(/[.,]$/, '');
  const lc = x.lastIndexOf(','), ld = x.lastIndexOf('.');
  if (lc > -1 && ld > -1) { const dec = lc > ld ? ',' : '.'; x = x.split(dec === ',' ? '.' : ',').join('').replace(dec, '.'); }
  else if (lc > -1 || ld > -1) { const sep = lc > -1 ? ',' : '.', parts = x.split(sep); x = (parts.length === 2 && parts[1].length !== 3) ? parts[0] + '.' + parts[1] : parts.join(''); }
  return parseFloat(x);
}
function parsePrice(p, shop) {
  if (!p) return null;
  const n = parseAmount(p); if (!isFinite(n) || n <= 0) return null;
  let cur = (CUR_RE.find(([re]) => re.test(p)) || [])[1];
  if (!cur) cur = /\.(ru|su|рф)$/i.test(shop || '') || n >= 500 ? 'RUB' : null;
  return cur ? { n, cur } : null;
}
const group = (n, dec) => { const [i, f] = n.toFixed(dec).split('.'); return i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (f ? ',' + f : ''); };
function money(n, cur) { const [a, z] = CUR_SYM[cur] || ['', ' ' + cur]; const dec = cur === 'RUB' || cur === 'JPY' || cur === 'KRW' || cur === 'KZT' || cur === 'AMD' ? 0 : (Math.round(n) === n ? 0 : 2); return a + group(n, dec) + z; }
function priceHtml(w) {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const p = parsePrice(w.price, w.shop);
  if (!p) return w.price ? `<b>${esc(String(w.price).slice(0, 14))}</b>` : '<b class="none">—</b>';
  let rub = '';
  if (p.cur !== 'RUB' && RATES && RATES.rub[p.cur]) rub = `<span class="num">≈ ${money(Math.round(p.n * RATES.rub[p.cur] / 10) * 10, 'RUB')}</span>`;
  return `<b class="num">${money(p.n, p.cur)}</b>${rub}`;
}

// ── Названия: бренд латиницей отдельно, остальное по-русски и коротко ──
const BRANDS = ["Walter Van Beirendonck","Raf Simons","Yohji Yamamoto","Issey Miyake","Dries Van Noten","Ann Demeulemeester","Helmut Lang","Jean Paul Gaultier","Martine Rose","Craig Green","Kiko Kostadinov","Undercover","Number (N)ine","Hysteric Glamour","Kapital","Needles","Engineered Garments","Carol Christian Poell","Boris Bidjan Saberi","Julius","Guidi","Maison Mihara Yasuhiro","Bape","A Bathing Ape","C.P. Company","CP Company","Vetements","Gosha Rubchinskiy","Chrome Hearts","Neil Barrett","1017 ALYX 9SM","Alyx","A-Cold-Wall","Acronym","Sunflower","Stüssy","Dirk Bikkembergs","Martin Margiela","Jil Sander","Ralph Lauren Purple Label","Yves Saint Laurent","Christian Dior","Comme des Garçons Homme Plus","Junya Watanabe MAN","Wacko Maria","Orslow","Beams","Nanamica","Snow Peak","And Wander","Arcteryx","Gramicci","Salomon","Oakley","Prada Linea Rossa","Miharayasuhiro","Doublet","Our Legacy","Séfr","Norse Projects","Wood Wood","Han Kjøbenhavn","Soulland","Holzweiler","Filippa K","Samsøe Samsøe","Libertine-Libertine","Tom Ford","Ermenegildo Zegna","Zegna","Brunello Cucinelli","Loro Piana","Kiton","Brioni","Canali","Corneliani","Isaia","Thom Browne","Bottega Veneta","Givenchy","Fendi","Dolce & Gabbana","Alexander Wang","Balmain","Max Mara","Jil Sander","The Row","Khaite","Toteme","Lemaire","Comme des Garçons","Junya Watanabe","Sacai","Visvim","Auralee","Aimé Leon Dore","Drake's","Officine Générale","Church's","Crockett & Jones","John Lobb","Paraboot","Red Wing","Tricker's","Santoni","Berluti","Hermès","Chanel","Louis Vuitton","Etro","Missoni","Zimmermann","Ganni","Nanushka","The Kooples","Claudie Pierlot","Vince","Theory","Polo Ralph Lauren","Ralph Lauren","Moon Boot","Mackintosh","Paul Smith","Vivienne Westwood","Marine Serre","Maison Margiela","MM6","Y-3","Mastermind","Neighborhood","Wtaps","Palm Angels","Amiri","Rhude","Casablanca","Jacquemus","Lanvin","Ami Paris","Charuel","Studio 29","Monochrome","Gate31","2Mood","Lesyanebo","Alexander Terekhov","Vassa","Ruban","Lime","Ushatava","Zarina","Carhartt WIP","Carhartt","The North Face","New Balance","Under Armour","Tommy Hilfiger","Tommy Jeans","Ralph Lauren","Polo Ralph Lauren","Calvin Klein","Massimo Dutti","Stone Island","Acne Studios","Our Legacy","Canada Goose","Helly Hansen","Fred Perry","Dr. Martens","Golden Goose","Common Projects","Saint Laurent","Alexander McQueen","Maison Margiela","Maison Kitsuné","Ami Paris","Lyle & Scott","Pull&Bear","Off-White","On Running","La Sportiva","Arc'teryx","Levi's","A.P.C.","Nike","Jordan","Adidas","Puma","Reebok","ASICS","Salomon","Vans","Converse","Timberland","UGG","Birkenstock","Clarks","Ecco","Geox","Camper","Hoka","Saucony","Brooks","Merrell","Mizuno","Fila","Kappa","Umbro","Lacoste","Boss","Hugo","Diesel","G-Star Raw","Wrangler","Lee","Gant","Burberry","Barbour","Patagonia","Columbia","Moncler","Woolrich","Sandro","Maje","Jacquemus","Valentino","Gucci","Prada","Miu Miu","Balenciaga","Versace","Dior","Celine","Loewe","Bottega Veneta","Uniqlo","Zara","H&M","COS","ARKET","Mango","Weekday","Monki","Reserved","Bershka","Stradivarius","ASOS","Stüssy","Stussy","Supreme","Dickies","Champion","Kangol","New Era","Napapijri","Mammut","Jack Wolfskin","Kith","Represent","Essentials","Fear of God","Rick Owens","Yeezy","Marni","Kenzo","Moschino","Love Republic","12 Storeez","Befree","Gloria Jeans","Lime","Ushatava","Zarina","Sela","O'stin","Kanzler","Henderson","Lamoda","Finn Flare","Sportmaster","Demix","Outventure","Termit","Sevenext"].sort((a, b) => b.length - a.length);
const BRAND_RU = { 'найк': 'Nike', 'адидас': 'Adidas', 'пума': 'Puma', 'рибок': 'Reebok', 'нью баланс': 'New Balance', 'конверс': 'Converse', 'ванс': 'Vans', 'юникло': 'Uniqlo', 'зара': 'Zara', 'асикс': 'ASICS', 'саломон': 'Salomon', 'тимберленд': 'Timberland', 'левис': "Levi's", 'кархарт': 'Carhartt WIP', 'фила': 'Fila', 'лакост': 'Lacoste', 'коламбия': 'Columbia', 'норт фейс': 'The North Face', 'джордан': 'Jordan', 'стон айленд': 'Stone Island', 'гучи': 'Gucci', 'прада': 'Prada', 'баленсиага': 'Balenciaga' };
const RU_TYPES = ['Кроссовки','Кеды','Ботинки','Сапоги','Туфли','Лоферы','Мокасины','Сандалии','Шлёпанцы','Шлепанцы','Слипоны','Угги','Худи','Толстовка','Свитшот','Футболка','Лонгслив','Рубашка','Поло','Свитер','Джемпер','Кардиган','Водолазка','Майка','Топ','Куртка','Пуховик','Пальто','Парка','Тренч','Бомбер','Ветровка','Плащ','Анорак','Жилет','Джинсы','Брюки','Чиносы','Шорты','Юбка','Платье','Джоггеры','Леггинсы','Кепка','Бейсболка','Шапка','Панама','Шляпа','Берет','Сумка','Рюкзак','Ремень','Носки','Шарф','Перчатки','Очки','Часы','Кольцо','Браслет','Комбинезон','Костюм','Пиджак','Блейзер'];
const EN_TYPES = [[/\b(running\s+)?(sneakers?|trainers?|running shoes?)\b/i,'Кроссовки'],[/\b(high-?tops?|canvas shoes?)\b/i,'Кеды'],[/\bchelsea boots?\b/i,'Челси'],[/\bboots?\b/i,'Ботинки'],[/\bloafers?\b/i,'Лоферы'],[/\bsandals?\b/i,'Сандалии'],[/\bslides?\b/i,'Шлёпанцы'],[/\bhoodie\b/i,'Худи'],[/\bsweatshirt\b|\bcrewneck\b/i,'Свитшот'],[/\blong ?sleeve\b/i,'Лонгслив'],[/\bt-?shirt\b|\btee\b/i,'Футболка'],[/\bovershirt\b/i,'Рубашка'],[/\bpolo\b/i,'Поло'],[/\bshirt\b|\boxford\b/i,'Рубашка'],[/\bcardigan\b/i,'Кардиган'],[/\b(sweater|jumper|knit)\b/i,'Свитер'],[/\b(down jacket|puffer)\b/i,'Пуховик'],[/\bparka\b/i,'Парка'],[/\btrench\b/i,'Тренч'],[/\bbomber\b/i,'Бомбер'],[/\b(vest|gilet)\b/i,'Жилет'],[/\bjacket\b/i,'Куртка'],[/\bcoat\b/i,'Пальто'],[/\bjeans\b|\bdenim\b/i,'Джинсы'],[/\bjoggers?\b|\bsweatpants\b/i,'Джоггеры'],[/\bshorts\b/i,'Шорты'],[/\b(trousers|pants|chinos?)\b/i,'Брюки'],[/\bskirt\b/i,'Юбка'],[/\bdress\b/i,'Платье'],[/\bbeanie\b/i,'Шапка'],[/\b(cap|baseball cap)\b/i,'Кепка'],[/\bbucket hat\b/i,'Панама'],[/\bhat\b/i,'Шляпа'],[/\bbackpack\b/i,'Рюкзак'],[/\bbag\b|\btote\b/i,'Сумка'],[/\bbelt\b/i,'Ремень'],[/\bsocks?\b/i,'Носки'],[/\bscarf\b/i,'Шарф'],[/\bgloves?\b/i,'Перчатки'],[/\bblazer\b/i,'Пиджак'],[/\bshoes?\b|\bfootwear\b/i,'__shoes']];
const SNEAKER_BRANDS = ['Nike','Jordan','Adidas','New Balance','ASICS','Puma','Reebok','Vans','Converse','Saucony','Hoka','On Running','Salomon','Mizuno','Brooks','Fila','Kappa','Yeezy'];
const reEsc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = x => new RegExp('(^|[^\\p{L}\\p{N}])' + reEsc(x) + '(?=$|[^\\p{L}\\p{N}])', 'iu');
function normTitle(title, shop, knownBrand) {
  let t = String(title || '').replace(/ /g, ' ').trim();
  // хвосты магазинов и мусор
  const B = '(?<![\\p{L}\\p{N}])', E = '(?![\\p{L}\\p{N}])';
  t = t.split(/\s[|•]\s|\s[—–-]\s/)[0];
  t = t.replace(new RegExp('\\s*[,]?\\s*' + B + '(купить|buy|заказать)' + E + '.*$', 'iu'), '').replace(/\s*(в|на)\s+(интернет[- ]магазине|официальном сайте|lamoda|ozon|wildberries).*$/iu, '');
  t = t.replace(new RegExp(',?\\s*' + B + '(арт(икул)?|sku|art)\\.?\\s*[:№#]?\\s*[\\w-]+', 'giu'), '');
  t = t.replace(new RegExp(B + '(?=[A-Z0-9-]*\\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9-]{6,}' + E, 'gu'), '').replace(new RegExp(B + '\\d{5,}' + E, 'gu'), '');
  t = t.replace(/\((?=[^)]*\d)[^)]*\)/g, '').replace(new RegExp(',?\\s*' + B + '(цвет|color|colour|размер|size)' + E + '\\s*:?.*$', 'iu'), '');
  t = t.replace(new RegExp(B + "(мужск\\p{L}*|женск\\p{L}*|детск\\p{L}*|унисекс|unisex|men'?s|women'?s|mens|womens|for (men|women))" + E, 'giu'), '');
  // бренд
  let brand = knownBrand || BRANDS.find(b => wordRe(b).test(t)) || null;
  if (!brand) { const k = Object.keys(BRAND_RU).find(r => wordRe(r).test(t)); if (k) { brand = BRAND_RU[k]; t = t.replace(wordRe(k), '$1'); } }
  if (!brand && shop) { const base = shop.replace(/^(www|m|shop|store)\./, '').split('.')[0].toLowerCase(); brand = BRANDS.find(b => b.toLowerCase().replace(/[^a-z0-9]/g, '') === base.replace(/-shop$/, '')) || null; }
  if (!brand && /[а-яё]/i.test(t)) { const m = t.match(/(?:^|(?<=[а-яёА-ЯЁ],?\s)|(?<=[«"(]))([A-Z][A-Za-z0-9'&.\-]*(?:\s+(?:&\s+)?[A-Z][A-Za-z0-9'&.\-]*){0,2})(?=$|[\s,»")])/); if (m && !/^(XS|S|M|L|XL|XXL|EU|US|UK|RU|SALE|NEW|OG|PRO)$/i.test(m[1])) brand = m[1].trim(); }
  if (brand) { t = t.replace(wordRe(brand), '$1'); if (brand === 'Carhartt WIP') t = t.replace(wordRe('Carhartt'), '$1'); }
  // тип вещи по-русски
  let type = RU_TYPES.find(x => wordRe(x).test(t)) || null;
  if (type) t = t.replace(wordRe(type), '$1');
  const e = EN_TYPES.find(([re]) => re.test(t));
  if (e) { if (!type) type = e[1] === '__shoes' ? (SNEAKER_BRANDS.includes(brand) ? 'Кроссовки' : 'Обувь') : e[1]; t = t.replace(e[0], ' '); }
  t = t.replace(/\s{2,}/g, ' ').replace(/^[\s,.;:–—\-/"«»']+|[\s,.;:–—\-/"«»']+$/g, '');
  let name = [type, t].filter(Boolean).join(' ').trim();
  if (!name) name = String(title || '').trim();
  name = name.charAt(0).toUpperCase() + name.slice(1);
  return { brand, name, type };
}
const isTg = u => /^https?:\/\/(t\.me|telegram\.me)\//i.test(u || '');

