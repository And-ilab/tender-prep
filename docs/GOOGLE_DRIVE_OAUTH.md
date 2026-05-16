# Google Drive: OAuth для **личного** аккаунта Gmail

Если вы **не** используете Google Workspace и общие диски, сервисный аккаунт часто получает **403 (нет квоты)** при записи на «Мой диск». В этом режиме Лена обращается к Drive **от вашего имени** через OAuth2: файлы создаются в **вашей** квоте.

## Что понадобится

- Один и тот же проект в [Google Cloud Console](https://console.cloud.google.com/), где уже включён **Google Drive API** (как для SA).
- Браузер под тем **Google-аккаунтом**, чей Диск должен использовать бот.

## 1. OAuth-клиент типа «Десктопное приложение»

1. **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**.
2. Если спросят экран согласия — заполните **OAuth consent screen** (тип «External» для личного аккаунта, тестовые пользователи — ваш email).
3. Application type: **Desktop app** → создать → скачать JSON (учётные данные клиента).

В файле должны быть поля вроде `"installed": { "client_id", "client_secret", ... }`.

## 2. Redirect URI (обязательно)

1. Откройте созданный **OAuth 2.0 Client ID** → **Authorized redirect URIs**.
2. Добавьте **точно** (порт по умолчанию **8742**):

   `http://127.0.0.1:8742/oauth2callback`

   Другой порт: задайте `LENA_GOOGLE_OAUTH_PORT` и добавьте URI с тем же портом.

Сохраните.

## 3. Один раз: получить `refresh_token`

В `.env` или в командной строке задайте пути (файл токена ещё **не** обязан существовать):

```powershell
$env:GOOGLE_DRIVE_OAUTH_CLIENT = "C:\secrets\google-oauth-client.json"
$env:GOOGLE_DRIVE_OAUTH_TOKEN = "C:\secrets\lena-drive-user-token.json"
cd c:\tender-prep
node src/cli.js drive oauth-login
```

Либо явно:

```powershell
node src/cli.js drive oauth-login "C:\secrets\google-oauth-client.json" "C:\secrets\lena-drive-user-token.json"
```

Скрипт:

1. Выведет **redirect URI** (проверьте совпадение с п. 2).
2. Даст ссылку — откройте в браузере, войдите, разрешите доступ к Drive.
3. После перенаправления на `127.0.0.1` в каталоге появится JSON с **`refresh_token`**.

Если Google **не вернёт** `refresh_token`: отзовите приложение в [Доступ аккаунта](https://myaccount.google.com/permissions) и повторите `oauth-login`.

**Не коммитьте** `lena-drive-user-token.json` и JSON клиента с `client_secret`.

## 4. Переменные для бота и CLI

Укажите **корень** на **вашем** Диске (папка в «Моём диске» или в общем доступе — как обычно для пользователя):

```env
LENA_DRIVE_ROOT=https://drive.google.com/drive/folders/ВАШ_ID
GOOGLE_DRIVE_OAUTH_CLIENT=C:\secrets\google-oauth-client.json
GOOGLE_DRIVE_OAUTH_TOKEN=C:\secrets\lena-drive-user-token.json
```

**Не задавайте** `GOOGLE_DRIVE_CREDENTIALS`, если полностью переходите на OAuth (иначе путаница). Если переменная всё ещё есть в системе — удалите её для сеанса бота.

Инициализация `_lena`:

```powershell
node src/cli.js drive workspace-ensure "ВАШ_ID_или_URL"
```

Запуск бота — как раньше: `node src/telegram/lena-bot.mjs` или `lena-bot.bat`.

## 5. Область доступа

Используется одна область: `https://www.googleapis.com/auth/drive` (полный доступ к Drive как у приложения с таким scope). Это соответствует прежнему режиму с сервисным аккаунтом по возможностям API.

## 6. Отзыв доступа

В любой момент: [Google Account → Security → Third-party access](https://myaccount.google.com/permissions) — удалить приложение. После этого нужен новый `oauth-login`.
