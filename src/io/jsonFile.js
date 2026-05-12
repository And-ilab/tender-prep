import { readFileSync, writeFileSync } from "node:fs";

/**
 * @param {string} path
 * @returns {unknown}
 */
export function readJsonFile(path) {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

/**
 * @param {string} path
 * @param {unknown} data
 */
export function writeJsonFile(path, data) {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  writeFileSync(path, text, "utf8");
}
