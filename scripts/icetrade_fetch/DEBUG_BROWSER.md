# Отладка IceTrade вручную (DevTools + консоль)

Используйте, когда бот даёт **0 файлов**: так вы увидите, где реально лежат ссылки (DOM, XHR).

## 1. Откройте карточку

Например: `https://icetrade.by/tenders/all/view/1336510`

Войдите в ЛК только если **ваша** карточка без входа не показывает вложения (многие закупки публичны).

## 2. Вкладка **Network** (Сеть)

На IceTrade блок **«Аукционные документы»** у части карточек **уже открыт** — кликать по вкладкам в автоматике не обязательно. В `.env` можно задать `LENA_ICETRADE_PLAYWRIGHT_SKIP_DOC_UI_CLICKS=1`.

- Включите **Preserve log** (Сохранять журнал).
- Фильтр **Fetch/XHR** (или **All** на время диагностики).
- Обновите страницу (**F5**) или откройте вкладку **«Документы» / «Аукционные документы»**.
- Кликните по запросам с типом **json** / **xhr**, откройте **Response** / **Preview**: поищите строки с `.pdf`, `download`, `file`, `attachment`.

Запишите **URL запроса** из колонки **Name** — пригодится, если понадобится доработать парсер.

## 3. Куки для бота (`LENA_ICETRADE_COOKIE`)

**Application** → **Cookies** → `https://icetrade.by`.

Проще всего: **Network** → любой запрос к `icetrade.by` → **Headers** → **Request Headers** → поле **cookie:** → скопируйте **только значение** (без префикса `Cookie:`).

В `.env`:

```env
LENA_ICETRADE_COOKIE=имя1=значение1; имя2=значение2
```

Не коммитьте `.env`.

## 4. Сниппет в **Console**

Откройте **Console**, вставьте целиком содержимое файла **`console_snippet_icetrade.js`** и нажмите Enter.

В Chrome/Edge список URL при возможности копируется в буфер (`copy()`).

## 5. Что передать в чат по итогам

- Есть ли URL в таблице консоли (да/нет).
- 1–3 примера URL или имя XHR из Network, если ссылки только там.

## 6. Playwright `storage` и Python

- Путь в **`LENA_ICETRADE_PLAYWRIGHT_STORAGE`** должен указывать на **существующий** JSON; иначе бот работает без ЛК и пишет предупреждение.
- Создание файла: `npm run icetrade:playwright-auth -- C:\secrets\icetrade-storage.json https://icetrade.by/tenders/all/view/1336510`
- `No module named 'playwright'` в Python: из каталога `scripts/icetrade_fetch` выполните  
  `py -3 -m pip install -r requirements.txt` и `py -3 -m playwright install chromium`
