import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { credentialsPath } from "./config.js";

const SCOPE = "https://www.googleapis.com/auth/drive";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** @type {{ token: string, until: number } | null} */
let cache = null;

function base64Url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlJson(obj) {
  return base64Url(JSON.stringify(obj));
}

/**
 * @param {string} keyFilePath
 */
function readServiceAccount(keyFilePath) {
  const raw = readFileSync(keyFilePath, "utf8");
  const sa = JSON.parse(raw);
  if (!sa.client_email || !sa.private_key) {
    throw new Error("В JSON сервисного аккаунта нужны client_email и private_key");
  }
  return {
    client_email: sa.client_email,
    private_key: String(sa.private_key).replace(/\\n/g, "\n"),
  };
}

/**
 * @param {string} keyFilePath
 */
async function fetchNewAccessToken(keyFilePath) {
  const sa = readServiceAccount(keyFilePath);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const sign = createSign("RSA-SHA256");
  sign.update(unsigned);
  const sig = sign.sign(sa.private_key);
  const jwt = `${unsigned}.${base64Url(sig)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = /** @type {Record<string, unknown>} */ (await res.json());
  if (!res.ok || typeof json.access_token !== "string") {
    throw new Error(`OAuth token: ${JSON.stringify(json)}`);
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  return { access_token: json.access_token, expires_in: expiresIn };
}

/**
 * Access token для Drive API (кэш по expires_in).
 * @param {string} keyFilePath
 */
export async function getCachedAccessToken(keyFilePath) {
  const marginMs = 60_000;
  if (cache && Date.now() < cache.until - marginMs) {
    return cache.token;
  }
  const { access_token, expires_in } = await fetchNewAccessToken(keyFilePath);
  cache = {
    token: access_token,
    until: Date.now() + expires_in * 1000,
  };
  return access_token;
}

/**
 * Сброс кэша (тесты).
 */
export function clearTokenCache() {
  cache = null;
}

/**
 * Токен с учётом пути из окружения.
 */
export async function getDriveAccessToken() {
  return getCachedAccessToken(credentialsPath());
}
