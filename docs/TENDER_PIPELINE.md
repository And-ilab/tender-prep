# Конвейер тендера (IceTrade → Drive)

**Источник истины по шагам процесса.** При добавлении нового этапа или изменении артефактов — обновить этот файл и соответствующий код (`src/icetrade/`, `src/tenders/cli.js`, бот).

| Шаг | Имя в коде / CLI | Вход | Выход на Drive | Статус |
|-----|-------------------|------|----------------|--------|
| **1 · Import** | `bootstrapIceTradeToDrive`, `tenders icetrade-bootstrap`, ссылка IceTrade в Telegram | URL/view id, HTML карточки | `inputs/` — вложения заказчика; **`inputs/icetrade-import-snapshot.json`** — снимок полей карточки и **события**; `notes/icetrade-bootstrap-*.md` | в разработке: снимок страницы + события |
| **2 · Extract** | `extractTenderInputDocumentsToExtracted`, `tenders tender-extract`, `/tenderextract` | файлы в `inputs/` | `inputs/extracted/*.txt`, `extract-manifest.json` | есть; PDF/DOC/DOCX — базово |
| **3 · Card** | `buildTenderTelegramCard`, `tenders tender-card`, `/tendercard` | `inputs/extracted` + опционально HTML IceTrade | `notes/tender-card-*.md`, сообщение Telegram | есть |
| **4 · Analyze** | `analyzeTenderAfterBootstrap`, кнопка «Анализ документов» в Telegram | текст из inputs | `notes/icetrade-analysis-*.md`; в чат — состав документов → компания → чеклист | есть |
| **4b · Checklist** | `documentChecklist.js`, `canonicalDocumentTypes.js`, `lena-bot.mjs` | результат Analyze | Telegram: «К подаче» → компания → догрузка + ссылки Drive → «Документы загружены» | есть |
| **5 · Commercial terms** | мастер в Telegram, `/tenderprice` | ответы менеджера | `notes/manager-price-quote.md` | есть |
| **6 · KP** | `runCommercialProposalDraftToDrive`, «Сформировать КП» | компания + условия + Preparation | `drafts/` | есть |

## Import (детали)

1. Загрузка HTML карточки (HTTP / Playwright по `LENA_ICETRADE_PLAYWRIGHT`).
2. Кандидаты вложений + скачивание в `inputs/`.
3. **Снимок карточки** — эвристический разбор HTML в JSON (**не замена** юридическому Извещению): URL, `view_id`, заголовок, телефоны, строки про цену/бюджет, блок **«События в хронологическом…»** (отмена и др.) для последующего **отслеживания** (повторный import или отдельный процесс сравнения — позже).

Файл: **`inputs/icetrade-import-snapshot.json`**, поля см. `schemaVersion` / `kind` внутри файла; логические блоки карточки и стабильные ключи **`structured`** — [ICETRADE_CARD_SNAPSHOT.md](ICETRADE_CARD_SNAPSHOT.md).

### КД по запросу заказчика (Telegram)

Эвристики в [`src/icetrade/competitiveDocsProvision.js`](../src/icetrade/competitiveDocsProvision.js) читают **`structured.competitiveDocuments.provisionTerms`** из снимка и имена файлов в **inputs/**.

| Ситуация | Import | После «Анализ документов» |
|----------|--------|---------------------------|
| Карточка **не** требует запрос | Как раньше — кнопка **«Анализ документов»** | Обычный список «К подаче» |
| Карточка требует запрос, **вложений нет** | Сообщение менеджеру + ссылка **inputs** + **«Документы загружены»** (без «Анализ документов») | — (после загрузки — extract + analyze) |
| Карточка требует запрос, **вложения есть** | Только **«Анализ документов»** (без предупреждения на Import) | **2а:** полная КД во вложениях → обычный список; **2б:** только образец заявления → сообщение + **inputs** + **«Документы загружены»** |
| Два способа (email и лично) | В тексте подсказки приоритет **email** | то же |

Триггер **«Документы загружены»** после загрузки комплекта в **inputs/** запускает extract + analyze и продолжает воронку.

## Extract (парсинг файлов)

Отдельный процесс: **не смешивать** с Import. После ручного добавления файлов в `inputs/` снова запускают **Extract**.

Папка **`inputs/extracted/`** создаётся **только** внутри `_lena/tenders/<год>/<view>/inputs/` (родитель каталога `extracted` всегда — папка **`inputs`** тендера). Если **Telegram** или CLI при парсинге создали на «Моём диске» в корне несколько папок с именем **`extracted`**, почти всегда это неверный **`LENA_DRIVE_ROOT`**: должен быть тот же корень, что для **`drive workspace-ensure`** (родитель для `_lena/`), а не id другой папки или файла. Перед извлечением код проверяет метаданные каталога `inputs`; при рассинхроне — ошибка с подсказкой, без создания папки в корне.

## Checklist (4b)

Эталонные типы документов — [`src/analysis/canonicalDocumentTypes.js`](../src/analysis/canonicalDocumentTypes.js) (22 типа). Нормализация и фильтры — [`src/analysis/documentChecklist.js`](../src/analysis/documentChecklist.js).

**Правила ветвления КД** (ГС Ритейл / Финсельват):

| Ветка в КД | Наша роль | В чеклист |
|------------|-----------|-----------|
| Резидент / нерезидент | Резидент РБ | Только документы **явной ветки резидента** (свидетельство о гос. регистрации и т.д.). **Не** выписка из торгового реестра |
| Производитель / представитель | Не производитель | Только ветка **представителя** (дилерское/агентское соглашение). **Не** справка ТПП |
| Товары не из СНГ | Поставка из Китая | Сертификат о происхождении — **если есть в п.3.2 КД** (извлечение LLM с цитатой) |
| Состав КП | — | Условия оплаты, гарантия — **внутри КП**, не отдельные строки |
| Референс / декларации | — | Только при **явном** названии в КД/ТЗ |
| Документы из ТЗ | — | Конкретные названия из текста ТЗ, не абстрактная фраза |

П. **3.2 КД** («Документы и сведения…»): каждый нумерованный подпункт = отдельная строка «К подаче».

Новые типы (2026-06): `state_registration_certificate`, `dealer_representative_docs`, `certificate_of_origin`, `conformity_declarations`, `compliance_statement`, `tz_compliance_table`.

Тесты нормализации: `npm test` → `src/analysis/` и `src/icetrade/` (в т.ч. `competitiveDocsProvision.test.mjs`).

## Дальнейшие процессы

- Сравнение двух снимков (дельта событий) — запланировано.
- Полный разбор PDF/DOC в `extracted` — см. `LENA_INPUT_EXTRACT_*`, развитие `inputDocumentsExtract.js`.

## См. также

- [ICETRADE_CARD_SNAPSHOT.md](ICETRADE_CARD_SNAPSHOT.md) — шаблон карточки IceTrade и JSON **`structured`**.
- [PRODUCT_CONTEXT.md](PRODUCT_CONTEXT.md) — продуктовый контекст.
- [GOOGLE_DRIVE.md](GOOGLE_DRIVE.md) — структура `_lena/tenders/…`.

