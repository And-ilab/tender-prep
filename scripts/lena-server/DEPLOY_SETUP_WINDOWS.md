# Автодеплой на Windows Server · пошаговая настройка

Один раз настраиваете сервер и секреты GitHub — дальше каждый **push в `main`** сам обновляет `C:\tender-prep` и перезапускает службу **tender-prep-lena**.

Нужны **два разных SSH-ключа** (не путать):

| Ключ | Где приватный | Где публичный | Зачем |
|------|---------------|---------------|--------|
| **A · CI → сервер** | GitHub Secret `LENA_DEPLOY_SSH_KEY` | `C:\Users\deploy\.ssh\authorized_keys` на сервере | GitHub Actions заходит по SSH и запускает деплой |
| **B · сервер → GitHub** | `C:\Users\deploy\.ssh\id_ed25519_github` на сервере | Deploy key в настройках репозитория GitHub | `git fetch origin main` с сервера |

---

## Шаг 0. Предпосылки

На сервере уже должны быть:

- `C:\tender-prep` — клон репозитория, бот хотя бы раз работал;
- служба **tender-prep-lena** (NSSM), `.env`, секреты в `C:\secrets\...`;
- Node.js, Git, Python (см. [README.md](README.md)).

Дальнейшие команды — в **PowerShell от администратора** на сервере (RDP), если не указано иное.

---

## Шаг 1. OpenSSH Server

### 1.1. Установка

**Windows Server 2019/2022 / Windows 10/11:**

```powershell
Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
```

Или: **Параметры → Приложения → Дополнительные компоненты → OpenSSH Server → Установить**.

### 1.2. Служба и автозапуск

```powershell
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
Get-Service sshd
```

### 1.3. Брандмауэр

```powershell
New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (SSH)" `
  -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

Если SSH только из вашей сети — ограничьте `-RemoteAddress` вашей подсетью/VPN.

### 1.4. Проверка

С **ноутбука** (пока под своей учёткой, если вход по паролю разрешён):

```powershell
ssh ИМЯ_ПОЛЬЗОВАТЕЛЯ@IP_СЕРВЕРА "hostname"
```

---

## Шаг 2. Пользователь `deploy`

### 2.1. Создание локальной учётки

```powershell
$password = Read-Host "Пароль для deploy" -AsSecureString
New-LocalUser -Name "deploy" -Password $password -FullName "GitHub deploy" `
  -Description "SSH deploy for tender-prep" -PasswordNeverExpires
```

### 2.2. Права на перезапуск службы

`deploy-from-main.ps1` вызывает `Restart-Service tender-prep-lena`. Без прав администратора это не сработает.

**Простой вариант (внутренний сервер):** добавить `deploy` в локальные администраторы:

```powershell
Add-LocalGroupMember -Group "Administrators" -Member "deploy"
```

**Более строгий вариант:** оставить отдельную учётку без админки и настроить задачу Планировщика с «Run with highest privileges», которая по сигналу запускает деплой — сложнее; для первой настройки используйте вариант выше.

### 2.3. Права на папку репозитория

```powershell
icacls "C:\tender-prep" /grant "deploy:(OI)(CI)M" /T
```

(`M` — изменение файлов; `.env` и секреты не в Git — они не затираются при `git reset`.)

### 2.4. Каталог `.ssh` для пользователя deploy

Войдите на сервер **как deploy** (или выполните от его имени):

```powershell
$sshDir = "C:\Users\deploy\.ssh"
New-Item -ItemType Directory -Force -Path $sshDir
icacls $sshDir /inheritance:r
icacls $sshDir /grant "deploy:(F)"
icacls $sshDir /grant "SYSTEM:(F)"
icacls $sshDir /grant "Administrators:(F)"
```

---

## Шаг 3. Ключ A — GitHub Actions → сервер

Генерируйте **на ноутбуке** (не на сервере), чтобы приватный ключ сразу попал только в GitHub Secrets.

```powershell
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\lena_deploy_ci -C "github-actions-deploy" -N '""'
```

Будут файлы:

- `lena_deploy_ci` — **приватный** → позже в Secret `LENA_DEPLOY_SSH_KEY`;
- `lena_deploy_ci.pub` — **публичный** → на сервер.

### 3.1. Публичный ключ на сервере

Содержимое `lena_deploy_ci.pub` одной строкой добавьте в файл на сервере:

`C:\Users\deploy\.ssh\authorized_keys`

```powershell
# на сервере, от администратора
$key = "ssh-ed25519 AAAA... github-actions-deploy"   # вставьте вашу строку из .pub
Add-Content -Path "C:\Users\deploy\.ssh\authorized_keys" -Value $key -Encoding ascii
icacls "C:\Users\deploy\.ssh\authorized_keys" /inheritance:r /grant "deploy:R" "SYSTEM:F" "Administrators:F"
```

### 3.2. Разрешить вход по ключу (sshd)

Откройте `C:\ProgramData\ssh\sshd_config` **от администратора**, проверьте:

```
PubkeyAuthentication yes
PasswordAuthentication no
```

После правок:

```powershell
Restart-Service sshd
```

### 3.3. Проверка ключа A

С ноутбука:

```powershell
ssh -i $env:USERPROFILE\.ssh\lena_deploy_ci deploy@IP_СЕРВЕРА "whoami"
```

Должно вывести `deploy` без запроса пароля.

---

## Шаг 4. Ключ B — сервер → GitHub (`git fetch`)

На **сервере**, под пользователем **deploy** (RDP или `runas`):

```powershell
ssh-keygen -t ed25519 -f C:\Users\deploy\.ssh\id_ed25519_github -C "tender-prep-server-read" -N '""'
Get-Content C:\Users\deploy\.ssh\id_ed25519_github.pub
```

Скопируйте вывод `.pub` (одна строка `ssh-ed25519 ...`).

### 4.1. Deploy key в GitHub

1. Откройте репозиторий: `https://github.com/And-ilab/tender-prep`
2. **Settings → Deploy keys → Add deploy key**
3. **Title:** `tender-prep Windows server read`
4. **Key:** вставьте содержимое `id_ed25519_github.pub`
5. **Allow write access** — **не включать** (только чтение)
6. **Add key**

### 4.2. SSH config для GitHub (на сервере, пользователь deploy)

Файл `C:\Users\deploy\.ssh\config`:

```
Host github.com
  HostName github.com
  User git
  IdentityFile C:/Users/deploy/.ssh/id_ed25519_github
  IdentitiesOnly yes
```

```powershell
icacls "C:\Users\deploy\.ssh\config" /inheritance:r /grant "deploy:R"
```

### 4.3. Remote репозитория на SSH

```powershell
cd C:\tender-prep
git remote -v
git remote set-url origin git@github.com:And-ilab/tender-prep.git
```

### 4.4. Проверка ключа B

Под **deploy**:

```powershell
ssh -T git@github.com
# ожидается: Hi And-ilab/tender-prep! You've successfully authenticated...

cd C:\tender-prep
git fetch origin main
```

Если `Permission denied` — deploy key не добавлен или не тот `.pub`.

---

## Шаг 5. Проверка деплоя без GitHub Actions

Под **deploy** по SSH или на консоли сервера:

```powershell
cd C:\tender-prep
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\lena-server\deploy-from-main.ps1 -NoRestart
```

Без ошибок `git fetch` / `npm install` — затем с перезапуском:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\lena-server\deploy-from-main.ps1
Get-Service tender-prep-lena
```

Лог: `C:\tender-prep\logs\deploy.log`.

С ноутбука (ключ A):

```powershell
ssh -i $env:USERPROFILE\.ssh\lena_deploy_ci deploy@IP_СЕРВЕРА `
  "powershell -NoProfile -ExecutionPolicy Bypass -File C:/tender-prep/scripts/lena-server/deploy-from-main.ps1"
```

---

## Шаг 6. Секреты в GitHub

1. Откройте `https://github.com/And-ilab/tender-prep`
2. **Settings → Secrets and variables → Actions**
3. Вкладка **Secrets → New repository secret** — по одному:

| Name | Value | Откуда взять |
|------|--------|--------------|
| `LENA_DEPLOY_HOST` | IP или DNS сервера | например `203.0.113.10` |
| `LENA_DEPLOY_USER` | `deploy` | имя из шага 2 |
| `LENA_DEPLOY_SSH_KEY` | **весь** файл `lena_deploy_ci` | приватный ключ A, включая строки `BEGIN/END OPENSSH PRIVATE KEY` |
| `LENA_DEPLOY_PATH` | `C:/tender-prep` | слэши **/** , без `\` |
| `LENA_DEPLOY_PORT` | `22` | опционально; можно не создавать, если порт 22 |

**Private key в Secret:** откройте `lena_deploy_ci` в блокноте, скопируйте **целиком**, без лишних пробелов в начале/конце.

### 6.1. Variable (опционально)

**Settings → Secrets and variables → Actions → Variables → New repository variable**

| Name | Value |
|------|--------|
| `LENA_DEPLOY_OS` | `windows` |

Если переменную не создавать — workflow по умолчанию использует ветку Windows.

---

## Шаг 7. Первый запуск pipeline

1. Закоммитьте и запушьте что-нибудь в **main** (или вручную: **Actions → Deploy Lena server → Run workflow**).
2. Откройте run workflow — шаг **Deploy via SSH (Windows)** должен быть зелёным.
3. На сервере: `Get-Content C:\tender-prep\logs\deploy.log -Tail 20`
4. В Telegram: `/help` — бот отвечает.

### Если job упал

| Ошибка | Что проверить |
|--------|----------------|
| `connection refused` / timeout | OpenSSH, брандмауэр, IP в `LENA_DEPLOY_HOST`, порт 22 с интернета (нужен белый IP или VPN) |
| `permission denied (publickey)` | `authorized_keys`, пользователь `LENA_DEPLOY_USER`, формат Secret ключа A |
| `git fetch failed` | deploy key B, `git remote`, `ssh -T git@github.com` под deploy |
| `Restart-Service failed` | права deploy (шаг 2.2), имя службы `tender-prep-lena` |
| `install-windows.ps1 failed` | Node/npm на PATH у пользователя deploy (часто нужен полный путь к node или вход deploy с тем же PATH, что у установки) |

**PATH для deploy:** если `npm` не находится при SSH, в NSSM/системе node уже есть — добавьте в профиль deploy или укажите полные пути в скрипте. Быстрая проверка:

```powershell
ssh -i ... deploy@SERVER "where.exe node; where.exe npm; where.exe git"
```

---

## Шаг 8. Безопасность (кратко)

- Приватный ключ A — **только** в GitHub Secret, не коммитить в Git.
- Deploy key B — **read-only**, только на сервере.
- Закройте SSH от всего интернета, если можно: VPN или белый список IP GitHub Actions ([meta API](https://api.github.com/meta) — ranges `actions`); иначе сильный ключ ed25519 и `PasswordAuthentication no`.
- `.env` и JSON-ключи **не** в репозитории — `git reset --hard` их не трогает.

---

## Связанные файлы

- Workflow: [`.github/workflows/deploy-lena-server.yml`](../../.github/workflows/deploy-lena-server.yml)
- Скрипт деплоя: [`deploy-from-main.ps1`](deploy-from-main.ps1)
- Общий README сервера: [README.md](README.md)
