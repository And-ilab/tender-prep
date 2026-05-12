# Google Drive для tender-prep / «Лена»

Интеграция нужна, чтобы хранить комплекты документов закупки на Диске, скачивать их локально под парсинг или загружать артефакты (например матрицу соответствия).

## Что сделано в коде

CLI: `node src/cli.js drive …` (после `npm install`, см. ниже).

| Команда | Действие |
|---------|----------|
| `drive list <папка>` | Список файлов в папке (id или URL вида `…/folders/…`) |
| `drive meta <файл\|папка>` | Метаданные в JSON |
| `drive download <файл> <путь>` | Скачать содержимое файла |
| `drive upload <папка> <локальный_файл> [имя]` | Загрузить файл в указанную папку |

Переменная окружения **`GOOGLE_DRIVE_CREDENTIALS`** (или стандартная **`GOOGLE_APPLICATION_CREDENTIALS`**) — **абсолютный или относительный путь к JSON ключу сервисного аккаунта** Google Cloud. Файл с ключом в Git не коммитить.

## Настройка в Google Cloud

1. Создайте проект в [Google Cloud Console](https://console.cloud.google.com/).
2. **APIs & Services → Library** — включите **Google Drive API**.
3. **IAM & Admin → Service Accounts** — создайте сервисный аккаунт, выпустите ключ JSON, сохраните файл локально (например `secrets/lena-drive.json`).
4. В **Google Drive** создайте папку под тендеры и **поделитесь** ею с email сервисного аккаунта (поле `client_email` в JSON) с правом **Редактор** (или «Читатель», если нужен только `drive list` / `download` — тогда в коде можно сузить scope; сейчас используется полный `https://www.googleapis.com/auth/drive` для совместимости с общими дисками и загрузкой).

Без шага «поделиться папкой» сервисный аккаунт **не увидит** личные файлы вашего пользователя.

## Установка зависимости

```bash
cd tender-prep
npm install
```

Если `npm install` падает с **UNABLE_TO_VERIFY_LEAF_SIGNATURE** (корпоративный TLS), настройте доверенный CA для Node (например `NODE_OPTIONS=--use-openssl-ca` при наличии системных корней) или зеркало registry по политике ИБ — без установки `googleapis` команды `drive` не запустятся.

Базовые команды `validate-input` / `matrix` по-прежнему работают **без** `node_modules`; для `drive` нужен установленный пакет `googleapis`.

## Пример (PowerShell)

```powershell
$env:GOOGLE_DRIVE_CREDENTIALS = "C:\path\to\service-account.json"
node src/cli.js drive list "https://drive.google.com/drive/folders/YOUR_FOLDER_ID"
```

## Общие диски (Shared Drives)

Вызовы API идут с `supportsAllDrives: true` и `includeItemsFromAllDrives: true`. Папка должна быть доступна сервисному аккаунту так же, как и на «Моём диске».

## Связка с `document_urls` во входе закупки

В [PARSERIT_INTEGRATION.md](PARSERIT_INTEGRATION.md) поле `document_urls` допускает строки-URL. Прямые ссылки вида `https://drive.google.com/...` для **публичных** файлов иногда открываются по HTTP; для закрытых документов надёжнее **скачивать через CLI** по `fileId` под учётом сервисного аккаунта и подставлять локальные пути или подписанные URL в свой пайплайн — это уже сценарий оркестратора (Windmill и т.д.), не обязательно самого `lena drive`.
