#!/usr/bin/env node
/**
 * Одноразовое сохранение сессии IceTrade для LENA_ICETRADE_PLAYWRIGHT_STORAGE.
 *
 *   npm install playwright
 *   npx playwright install chromium
 *   node scripts/icetrade-playwright-auth.mjs C:\secrets\icetrade-storage.json
 *
 * Откроется окно Chromium — войдите на icetrade.by, затем вернитесь в консоль и нажмите Enter.
 */
import { chromium } from "playwright";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const outPath = process.argv[2] || "icetrade-storage.json";

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  locale: "ru-RU",
});
const page = await context.newPage();
await page.goto("https://icetrade.by/");

const rl = createInterface({ input, output });
console.error(`В открывшемся окне войдите на IceTrade (если нужно).\nЗатем нажмите Enter здесь, чтобы сохранить: ${outPath}`);
await rl.question("");
rl.close();

await context.storageState({ path: outPath });
await browser.close();
console.error(`Готово: ${outPath}\nВ .env: LENA_ICETRADE_PLAYWRIGHT_STORAGE=${outPath}`);
