# Google Drive и «Лена»: папки, шаблоны, контекст

**Пошаговая настройка Google Cloud, Drive API и JSON-ключа:** отдельный файл [GOOGLE_DRIVE_GCP_SETUP.md](GOOGLE_DRIVE_GCP_SETUP.md).

Цель — чтобы **Лена** (агент или оператор по сценарию) работала с **одной согласованной структурой** на Google Drive: сама **создавала и переименовывала** папки под тендеры, **видела шаблоны** документов, **подтягивала ранее положенные файлы** как общий контекст.

## Корень и служебная папка `_lena`

1. Вы создаёте на Диске **одну корневую папку** под проект (например «Тендеры ACME») и **расшариваете** её сервисному аккаунту с правом **Редактор** (см. ниже про ключ).
2. Внутри этой папки код создаёт каталог **`_lena/`** (префикс снижает риск пересечения с вашими уже существующими именами).

Структура после команды `workspace-ensure`:

```text
<ваша корневая папка>/
  _lena/
    templates/     ← шаблоны (Google Docs/Sheets, PDF, DOCX — что положите)
    context/       ← общий контекст: прошлые заявки, глоссарий, политики, заметки
    tenders/
      <tender_id>/   ← имя папки = безопасная версия вашего tender_id
        inputs/      ← комплект документов закупки (загрузка сюда)
        drafts/      ← черновики ответа (копии шаблонов, правки)
        exports/     ← matrix.json, snapshot.json и т.д.
```

**Шаблоны:** храните в `_lena/templates`. Лена смотрит список через `templates-list` или полный снимок `agent-bundle`.

**Контекст:** всё, что должно «помнить» модель между тендерами, кладите в `_lena/context`. Лена получает список (`context-list`) или локальную выгрузку (`context-pull` → `.txt` для Google Docs, `.csv` для Sheets, скачивание бинарников).

**Тендер:** команда `workspace-tender` создаёт при необходимости дерево `tenders/<tender_id>/{inputs,drafts,exports}`. Копия шаблона в черновики: `template-copy`.

## Настройка доступа (сервисный аккаунт)

Полная пошаговая инструкция (проект, биллинг, включение API, ключ, шаринг папки, `GOOGLE_DRIVE_CREDENTIALS`, проверка `node`): **[GOOGLE_DRIVE_GCP_SETUP.md](GOOGLE_DRIVE_GCP_SETUP.md)**.

Кратко: JSON-ключ сервисного аккаунта + переменная **`GOOGLE_DRIVE_CREDENTIALS`** (или **`GOOGLE_APPLICATION_CREDENTIALS`**) + папка на Диске расшарена на **`client_email`** из JSON с ролью **Редактор**.

## Установка

```bash
cd tender-prep
npm install
```

Если `npm install` падает с **UNABLE_TO_VERIFY_LEAF_SIGNATURE**, настройте доверенный CA для Node (например `NODE_OPTIONS=--use-openssl-ca`) или политику registry по ИБ.

## Команды CLI (сводка)

| Команда | Назначение |
|---------|------------|
| `drive workspace-ensure <root>` | Создать `_lena/{templates,context,tenders}` при отсутствии |
| `drive workspace-layout <root>` | Показать id папок (без создания) |
| `drive workspace-tender <root> <tenderId>` | Папка тендера + `inputs` / `drafts` / `exports` |
| `drive templates-list <root>` | Список файлов в `_lena/templates` |
| `drive context-list <root>` | Список файлов в `_lena/context` |
| `drive context-pull <root> <локальнаяПапка>` | Выгрузить контекст локально для промпта |
| `drive template-copy <root> <idШаблона> <tenderId> [имя]` | Копия файла (в т.ч. Google Doc) в `drafts` |
| `drive item-rename <id> <новоеИмя>` | Переименовать папку или файл |
| `drive agent-bundle <root> [tenderId]` | Один JSON: id папок, шаблоны, контекст (+ дерево тендера, с созданием папок при необходимости) |

Низкоуровневые `list`, `meta`, `download`, `upload` сохраняются для произвольных путей.

Пример (PowerShell):

```powershell
$env:GOOGLE_DRIVE_CREDENTIALS = "C:\secrets\lena-drive.json"
node src/cli.js drive workspace-ensure "https://drive.google.com/drive/folders/ROOT_ID"
node src/cli.js drive workspace-tender "ROOT_ID" "zakupka-2026-042"
node src/cli.js drive agent-bundle "ROOT_ID" "zakupka-2026-042"
```

`<root>` везде — **id или URL** той самой **корневой** папки проекта (не обязательно `_lena`).

## Как этим пользоваться в сценарии «Лена»

1. Один раз: `workspace-ensure`, положить шаблоны и контекстные файлы в нужные подпапки.
2. На новый тендер: `workspace-tender` (или сразу `agent-bundle` с `tenderId` — дерево создастся само).
3. Перед генерацией ответа агенту: `agent-bundle` или `context-pull` + `templates-list`, чтобы в промпт попали **имена, ссылки и типы** файлов.
4. Черновик: `template-copy` копирует шаблон в `drafts`; дальше правки — в Google Docs вручную или через другие интеграции.

## Общие диски (Shared Drives)

Запросы к API идут с `supportsAllDrives: true`. Корневая папка может жить на общем диске, если сервисный аккаунт добавлен в участники с нужной ролью.

## Связка с репозиторием

Локальные команды `validate-input`, `matrix` и т.д. не зависят от Диска. Типичный поток: **скачать** комплект в `inputs/` (через `upload` или вручную в UI), затем локально прогнать парсинг и положить `exports/matrix.json` на Диск через `upload`.
