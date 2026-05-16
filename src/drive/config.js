import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Режим «личный Google»: OAuth пользователя (refresh_token), без квоты SA.
 */
export function useUserOAuthForDrive() {
  return Boolean(process.env.GOOGLE_DRIVE_OAUTH_TOKEN?.trim());
}

/**
 * JSON «Учётные данные клиента» из GCP (тип «Десктопное приложение»): installed { client_id, client_secret, … }.
 * Переменная: GOOGLE_DRIVE_OAUTH_CLIENT
 * @returns {string}
 */
export function oauthClientSecretsPath() {
  const p = process.env.GOOGLE_DRIVE_OAUTH_CLIENT?.trim();
  if (!p) {
    throw new Error(
      "Задайте GOOGLE_DRIVE_OAUTH_CLIENT — путь к JSON OAuth-клиента (Desktop) из Google Cloud.",
    );
  }
  return resolve(p);
}

/**
 * Файл с сохранённым refresh_token (создаётся командой drive oauth-login).
 * Переменная: GOOGLE_DRIVE_OAUTH_TOKEN
 * @returns {string}
 */
export function oauthTokenPath() {
  const p = process.env.GOOGLE_DRIVE_OAUTH_TOKEN?.trim();
  if (!p) {
    throw new Error(
      "Задайте GOOGLE_DRIVE_OAUTH_TOKEN — путь к JSON с refresh_token (см. drive oauth-login).",
    );
  }
  return resolve(p);
}

/**
 * Путь к JSON ключу сервисного аккаунта (если не используете OAuth пользователя).
 * @returns {string}
 */
export function credentialsPath() {
  const p =
    process.env.GOOGLE_DRIVE_CREDENTIALS?.trim() ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!p) {
    throw new Error(
      "Задайте GOOGLE_DRIVE_CREDENTIALS (или GOOGLE_APPLICATION_CREDENTIALS) — путь к JSON сервисного аккаунта, либо используйте GOOGLE_DRIVE_OAUTH_TOKEN + GOOGLE_DRIVE_OAUTH_CLIENT.",
    );
  }
  return resolve(p);
}

/**
 * Проверка файлов перед вызовами Drive API.
 */
export function assertCredentialsFile() {
  if (useUserOAuthForDrive()) {
    const cs = oauthClientSecretsPath();
    const tp = oauthTokenPath();
    try {
      readFileSync(cs, "utf8");
    } catch {
      throw new Error(`Не удаётся прочитать OAuth-клиент: ${cs}`);
    }
    try {
      readFileSync(tp, "utf8");
    } catch {
      throw new Error(
        `Нет файла токена: ${tp}. Выполните из корня репозитория:\n  node src/cli.js drive oauth-login`,
      );
    }
    return cs;
  }
  const p = credentialsPath();
  try {
    readFileSync(p, "utf8");
  } catch {
    throw new Error(`Не удаётся прочитать файл ключей: ${p}`);
  }
  return p;
}
