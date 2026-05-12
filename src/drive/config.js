import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Путь к JSON ключу сервисного аккаунта.
 * @returns {string}
 */
export function credentialsPath() {
  const p =
    process.env.GOOGLE_DRIVE_CREDENTIALS?.trim() ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!p) {
    throw new Error(
      "Задайте GOOGLE_DRIVE_CREDENTIALS (или GOOGLE_APPLICATION_CREDENTIALS) — путь к JSON сервисного аккаунта.",
    );
  }
  return resolve(p);
}

/**
 * Проверка, что файл ключа существует (читаемость).
 */
export function assertCredentialsFile() {
  const p = credentialsPath();
  try {
    readFileSync(p, "utf8");
  } catch {
    throw new Error(`Не удаётся прочитать файл ключей: ${p}`);
  }
  return p;
}
