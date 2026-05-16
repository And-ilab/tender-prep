import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { resolve } from "node:path";

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const DEFAULT_AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth";
const REDIRECT_PATH = "/oauth2callback";

/**
 * @param {string} path
 */
export function readOAuthClientSecrets(path) {
  const raw = readFileSync(path, "utf8");
  const j = JSON.parse(raw);
  const inst = j.installed ?? j.web;
  if (!inst?.client_id || !inst?.client_secret) {
    throw new Error(
      "OAuth JSON: ожидается ключ «Учётные данные клиента» с полем installed или web и client_id, client_secret",
    );
  }
  return {
    client_id: inst.client_id,
    client_secret: inst.client_secret,
    token_uri: typeof inst.token_uri === "string" ? inst.token_uri : DEFAULT_TOKEN_URI,
    auth_uri: typeof inst.auth_uri === "string" ? inst.auth_uri : DEFAULT_AUTH_URI,
  };
}

/**
 * @param {string} path
 */
export function readStoredRefreshToken(path) {
  const raw = readFileSync(path, "utf8");
  const t = JSON.parse(raw);
  if (typeof t.refresh_token !== "string" || !t.refresh_token.trim()) {
    throw new Error(`В ${path} нет refresh_token — выполните: node src/cli.js drive oauth-login …`);
  }
  return t.refresh_token.trim();
}

/** @type {{ token: string, until: number } | null} */
let userCache = null;

/**
 * @param {string} clientSecretsPath
 * @param {string} tokenPath
 */
export async function getUserOAuthAccessToken(clientSecretsPath, tokenPath) {
  const marginMs = 60_000;
  if (userCache && Date.now() < userCache.until - marginMs) {
    return userCache.token;
  }
  const client = readOAuthClientSecrets(clientSecretsPath);
  const refresh_token = readStoredRefreshToken(tokenPath);
  const body = new URLSearchParams({
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token,
    grant_type: "refresh_token",
  });
  const res = await fetch(client.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = /** @type {Record<string, unknown>} */ (await res.json());
  if (!res.ok || typeof json.access_token !== "string") {
    throw new Error(`OAuth refresh: ${JSON.stringify(json)}`);
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  userCache = { token: json.access_token, until: Date.now() + expiresIn * 1000 };
  return json.access_token;
}

export function clearUserOAuthCache() {
  userCache = null;
}

/**
 * Одноразовый вход: браузер → Google → redirect на localhost с code → сохранение refresh_token.
 * В Cloud Console у OAuth-клиента должен быть разрешён redirect URI (см. docs/GOOGLE_DRIVE_OAUTH.md).
 *
 * @param {string} clientSecretsPath
 * @param {string} tokenOutPath
 */
export async function runOAuthLoginInteractive(clientSecretsPath, tokenOutPath) {
  const client = readOAuthClientSecrets(resolve(clientSecretsPath));
  const port =
    Number.parseInt(process.env.LENA_GOOGLE_OAUTH_PORT?.trim() ?? "8742", 10) || 8742;
  const redirectUri = `http://127.0.0.1:${port}${REDIRECT_PATH}`;

  const authParams = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive",
    access_type: "offline",
    prompt: "consent",
  });
  const authUrl = `${client.auth_uri}?${authParams.toString()}`;

  const code = await new Promise((resolveP, reject) => {
    /** @type {import('node:http').Server | undefined} */
    let server;
    const timeout = setTimeout(() => {
      if (server) server.close();
      reject(new Error("Таймаут OAuth (120 с): не получен code с redirect."));
    }, 120_000);

    server = http.createServer((req, res) => {
      void (async () => {
        try {
          const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
          if (u.pathname !== REDIRECT_PATH) {
            res.writeHead(404);
            res.end();
            return;
          }
          const oerr = u.searchParams.get("error");
          const c = u.searchParams.get("code");
          if (oerr) {
            res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
            res.end(`<body><meta charset="utf-8"><p>Ошибка OAuth: ${oerr}</p></body>`);
            clearTimeout(timeout);
            server?.close();
            reject(new Error(`OAuth: ${oerr}`));
            return;
          }
          if (!c) {
            res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
            res.end(`<body><meta charset="utf-8"><p>Нет параметра code</p></body>`);
            clearTimeout(timeout);
            server?.close();
            reject(new Error("OAuth: пустой code"));
            return;
          }
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(
            `<body><meta charset="utf-8"><p>Авторизация получена. Можно закрыть вкладку и вернуться в терминал.</p></body>`,
          );
          clearTimeout(timeout);
          server?.close();
          resolveP(c);
        } catch (e) {
          clearTimeout(timeout);
          server?.close();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    });

    server.listen(port, "127.0.0.1", () => {
      console.error("");
      console.error("1) В консоли Google Cloud для этого OAuth-клиента добавьте «URI перенаправления»:");
      console.error(`   ${redirectUri}`);
      console.error("");
      console.error("2) Откройте в браузере (под нужным Google-аккаунтом):");
      console.error(`   ${authUrl}`);
      console.error("");
    });
    server.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });

  const body = new URLSearchParams({
    code,
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(client.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = /** @type {Record<string, unknown>} */ (await res.json());
  if (!res.ok) {
    throw new Error(`Обмен code: ${JSON.stringify(json)}`);
  }

  let refresh_token = typeof json.refresh_token === "string" ? json.refresh_token.trim() : "";
  if (!refresh_token) {
    try {
      const prev = JSON.parse(readFileSync(resolve(tokenOutPath), "utf8"));
      if (typeof prev.refresh_token === "string") {
        refresh_token = prev.refresh_token.trim();
      }
    } catch {
      /* no previous token */
    }
  }
  if (!refresh_token) {
    throw new Error(
      [
        "Google не вернул refresh_token.",
        "Отзовите доступ приложения: https://myaccount.google.com/permissions — удалите это приложение и запустите oauth-login снова.",
        `Ответ: ${JSON.stringify(json)}`,
      ].join("\n"),
    );
  }

  const out = {
    refresh_token,
    token_type: typeof json.token_type === "string" ? json.token_type : "Bearer",
    scope: typeof json.scope === "string" ? json.scope : undefined,
  };
  writeFileSync(resolve(tokenOutPath), JSON.stringify(out, null, 2), "utf8");
  console.error(`Готово. Сохранён refresh_token: ${resolve(tokenOutPath)}`);
}
