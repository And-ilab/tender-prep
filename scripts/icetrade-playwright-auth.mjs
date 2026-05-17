#!/usr/bin/env node
/**
 * Сохранение storageState Playwright (`LENA_ICETRADE_PLAYWRIGHT_STORAGE`): куки с реального Chromium на карточке.
 * Карточки и файлы на IceTrade часто **публичные**; JSON нужен не «для ЛК», а чтобы автоматика получала тот же набор кук/контекст, что и браузер, если `getFile` отдаёт HTML скрипту.
 *
 *   npm install playwright
 *   npx playwright install chromium
 *   node scripts/icetrade-playwright-auth.mjs "C:\secrets\icetrade-storage.json"
 *     → по умолчанию откроется https://icetrade.by/tenders/all/view/1336510
 *   node scripts/icetrade-playwright-auth.mjs "C:\secrets\icetrade-storage.json" "https://icetrade.by/tenders/all/view/1336510"
 *   node scripts/icetrade-playwright-auth.mjs "C:\secrets\icetrade-storage.json" 1336510
 *
 * Другая карточка: второй аргумент или в .env: LENA_ICETRADE_PLAYWRIGHT_AUTH_START_URL=…
 *
 * Откроется окно Chromium **сразу на карточке** — дождитесь полной загрузки (как в обычном просмотре), затем **Enter** в консоли для сохранения JSON.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { normalizeIceTradeViewId } from "../src/icetrade/viewIds.js";

function loadEnvFromRepoRoot() {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key.startsWith("LENA_")) process.env[key] = val;
    else if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvFromRepoRoot();

/** Карточка по умолчанию для сохранения сессии, если не заданы argv / env. */
const DEFAULT_ICETRADE_AUTH_CARD = "https://icetrade.by/tenders/all/view/1336510";

const VIEW_PAGE = (/** @type {string} */ id) => `https://icetrade.by/tenders/all/view/${id}`;

/**
 * @param {string | undefined} raw — полный URL, …/view/id или голый id
 */
function resolveIceTradeStartUrl(raw) {
  const s = raw?.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s.split("#")[0] || s;
  const id = normalizeIceTradeViewId(s);
  if (id) return VIEW_PAGE(id);
  return null;
}

const rawArg = process.argv[2];
const rawStart =
  process.argv[3] ?? process.env.LENA_ICETRADE_PLAYWRIGHT_AUTH_START_URL ?? DEFAULT_ICETRADE_AUTH_CARD;

if (!rawArg?.trim()) {
  console.error("Укажите путь к JSON (стартовая карточка по умолчанию — view/1336510), например:");
  console.error(
    '  node scripts/icetrade-playwright-auth.mjs "C:\\secrets\\icetrade-storage.json"',
  );
  console.error(
    '  node scripts/icetrade-playwright-auth.mjs "C:\\secrets\\icetrade-storage.json" "https://icetrade.by/tenders/all/view/1336510"',
  );
  console.error("  node scripts/icetrade-playwright-auth.mjs \"C:\\secrets\\icetrade-storage.json\" 1336510");
  console.error(
    "Другая карточка: второй аргумент или LENA_ICETRADE_PLAYWRIGHT_AUTH_START_URL в .env",
  );
  process.exit(1);
}

const startUrl = resolveIceTradeStartUrl(typeof rawStart === "string" ? rawStart : undefined);
if (!startUrl) {
  console.error("Внутренняя ошибка: не удалось разобрать URL карточки.");
  process.exit(1);
}

const outPath = resolve(rawArg.trim());

let browser;
try {
  await mkdir(dirname(outPath), { recursive: true });
} catch (e) {
  console.error(`Не удалось создать каталог для файла: ${dirname(outPath)}`);
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

try {
  browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    locale: "ru-RU",
  });
  const page = await context.newPage();
  console.error(`Открываю карточку:\n  ${startUrl}`);
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });

  const rl = createInterface({ input, output });
  console.error(
    `Дождитесь загрузки карточки в окне (как в обычном браузере; ЛК для публичных закупок обычно не нужен).\n` +
      `Этот шаг **не скачивает файлы** и **не** обязан открывать «Сохранить как» — только куки в JSON для Playwright.\n` +
      `Проверка PDF: node scripts/icetrade-download-diagnose.mjs … или bootstrap Лены.\n` +
      `Когда страница в порядке, нажмите Enter здесь, чтобы записать:\n  ${outPath}`,
  );
  await rl.question("");
  rl.close();

  await context.storageState({ path: outPath });

  const st = await stat(outPath);
  if (!st.isFile() || st.size < 32) {
    throw new Error(`файл не создался или пустой (${st.size} B)`);
  }

  console.error(`Готово: ${outPath} (${st.size} B)`);
  console.error(`В .env: LENA_ICETRADE_PLAYWRIGHT_STORAGE=${outPath}`);
} catch (e) {
  console.error("Ошибка:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
}

if (process.exitCode) process.exit(process.exitCode);
