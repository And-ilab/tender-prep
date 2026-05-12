# tender-prep · сервис «Лена»

Репозиторий подготовки тендерных материалов и сценариев вокруг сервиса **«Лена»**: сбор контекста закупки, структурирование входных данных и (опционально) связка с пайплайнами парсинга в Windmill (пространство **parserit**). **Сейчас в коде только локальный модуль** — без вызовов Windmill.

## Документация

| Файл | Назначение |
|------|------------|
| [docs/PRODUCT_CONTEXT.md](docs/PRODUCT_CONTEXT.md) | Продуктовый контекст: для кого Лена, границы ответственности, сущности и термины |
| [docs/PARSERIT_INTEGRATION.md](docs/PARSERIT_INTEGRATION.md) | Интеграция с parserit: пути скриптов/флоу в Windmill, входы/выходы, типовой порядок вызовов |
| [docs/WINDOWS_GIT.md](docs/WINDOWS_GIT.md) | Работа с Git на Windows для этого репозитория и смежных проектов |
| [docs/GOOGLE_DRIVE.md](docs/GOOGLE_DRIVE.md) | Google Drive: сервисный аккаунт, команды CLI `drive` |
| [docs/GOOGLE_DRIVE_GCP_SETUP.md](docs/GOOGLE_DRIVE_GCP_SETUP.md) | Пошагово: GCP, включение Drive API, ключ, шаринг папки, проверка из Node |
| [docs/TELEGRAM.md](docs/TELEGRAM.md) | Тестовая группа в Telegram и смоук-бот (Bot API) |

Перед изменениями в коде или промптах агентов имеет смысл начинать с **PRODUCT_CONTEXT**, затем сверяться с контрактом **parserit**, при работе с Диском — с **GOOGLE_DRIVE**, для тестов в мессенджере — **TELEGRAM**, с Git на Windows — **WINDOWS_GIT**.

## Кратко о «Лене»

**Лена** — сервис (или роль агента), который помогает готовить ответы на тендеры: извлекает требования из документов закупки, сверяет их с матрицей соответствия и подготавливает черновики разделов заявки. Тяжёлый разбор документов и унификация структуры выполняются во внешних задачах **parserit** в Windmill; этот репозиторий хранит правила, контекст продукта и сценарии подготовки, а не обязательно сам рантайм Windmill.

## Локальный модуль (без Windmill)

Нужен **Node.js 20+**. Сборка не требуется.

```bash
node src/cli.js validate-input examples/tender-input.sample.json
node src/cli.js validate-result examples/parser-result.sample.json
node src/cli.js snapshot examples/parser-result.sample.json out/snapshot.json
node src/cli.js matrix examples/parser-result.sample.json out/matrix.json
```

Команды **validate / snapshot / matrix** не тянут внешние пакеты. Для **Google Drive** выполните `npm install` (пакет `googleapis`), задайте `GOOGLE_DRIVE_CREDENTIALS` и см. [docs/GOOGLE_DRIVE.md](docs/GOOGLE_DRIVE.md):

```bash
node src/cli.js drive list "<url_или_id_папки>"
```

Либо: `npm run lena -- validate-input …` (скрипт вызывает тот же `node src/cli.js`).

Исходники: `src/` — валидация JSON, снимок, матрица; `src/drive/` — Drive API. Точка для Windmill/parserit остаётся внешней.
## Структура репозитория

- `docs/` — человекочитаемый контракт и контекст (в т.ч. для ИИ-агентов).
- `src/` — реализация «Лены» (валидация JSON, снимок, матрица) и опционально `src/drive/`.
- `examples/` — примеры входа закупки, результата парсера и шаблон переменных для Диска.

## Лицензия и доступ

Уточняются владельцем репозитория. Доступ к Windmill и namespace `parserit` выдаётся отдельно от доступа к Git. Ключ сервисного аккаунта Google не хранить в репозитории (см. `secrets/` в `.gitignore`).
