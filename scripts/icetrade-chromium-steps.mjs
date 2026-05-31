#!/usr/bin/env node
/**
 * Пошаговая отладка в **видимом** Chromium: карточка → документы → клик по строке (часто модал «Загрузка файла») → клик по PDF в модалке.
 * Между шагами жмите Enter в консоли. Нужен Playwright + chromium.
 *
 *   cd C:\tender-prep
 *   node scripts/icetrade-chromium-steps.mjs https://icetrade.by/tenders/all/view/1336510
 *
 * Переменные: как у bootstrap (.env из корня): LENA_ICETRADE_PLAYWRIGHT_STORAGE, LENA_ICETRADE_COOKIE, …
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { normalizeIceTradeViewId } from "../src/icetrade/viewIds.js";
import { resolveIceTradeModalPdfLink, clickIceTradeModalLinkReliable, applyPlaywrightDownloadsPath, readIceTradeLinkSiteFilename, persistIceTradePlaywrightDownload, getPlaywrightDownloadsDir, maybeCleanupPlaywrightDownloadsBase } from "../src/icetrade/fetchPageRendered.js";

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

const VIEW_PAGE = (/** @type {string} */ id) => `https://icetrade.by/tenders/all/view/${id}`;

function timeoutMs() {
  const t =
    Number.parseInt(process.env.LENA_ICETRADE_FETCH_TIMEOUT_MS?.trim() ?? "120000", 10) || 120_000;
  return Math.max(15_000, t);
}

function playwrightIgnoreTlsErrors() {
  const v = process.env.LENA_ICETRADE_PLAYWRIGHT_IGNORE_TLS_ERRORS?.trim().toLowerCase() ?? "";
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

async function pause(rl, title) {
  console.error(`\n>>> ${title}`);
  await rl.question("    Enter — продолжить\n");
}

const raw = process.argv[2]?.trim();
if (!raw) {
  console.error("Укажите URL или id карточки, например:");
  console.error("  node scripts/icetrade-chromium-steps.mjs https://icetrade.by/tenders/all/view/1336510");
  process.exit(1);
}

const cardUrl = /^https?:\/\//i.test(raw)
  ? raw.split("#")[0].split("?")[0]
  : VIEW_PAGE(normalizeIceTradeViewId(raw) || raw);

const viewId = normalizeIceTradeViewId(cardUrl) || "";

const nArg = process.argv[3]?.trim() ?? "0";
const nParam = /^\d+$/.test(nArg) ? nArg : "0";

/** @type {import('playwright').Browser | undefined} */
let browser;
const rl = createInterface({ input, output });

try {
  const playwright = await import("playwright");
  const storageRaw = process.env.LENA_ICETRADE_PLAYWRIGHT_STORAGE?.trim();
  const storagePath = storageRaw && existsSync(storageRaw) ? storageRaw : undefined;
  const ua =
    process.env.LENA_ICETRADE_USER_AGENT?.trim() ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  await pause(rl, "Шаг 0: сейчас откроется Chromium (окно должно быть видно).");

  await maybeCleanupPlaywrightDownloadsBase();

  browser = await playwright.chromium.launch({ headless: false });
  /** @type {import('playwright').BrowserContextOptions} */
  const ctxOpts = {
    acceptDownloads: true,
    userAgent: ua,
    locale: "ru-RU",
    ignoreHTTPSErrors: playwrightIgnoreTlsErrors(),
    extraHTTPHeaders: { "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.4" },
  };
  const cookie = process.env.LENA_ICETRADE_COOKIE?.trim();
  if (cookie) ctxOpts.extraHTTPHeaders = { ...ctxOpts.extraHTTPHeaders, Cookie: cookie };
  if (storagePath) ctxOpts.storageState = storagePath;
  applyPlaywrightDownloadsPath(ctxOpts, viewId || undefined);

  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();

  await pause(rl, "Шаг 1: переход на карточку тендера.");
  await page.goto(cardUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs() });
  try {
    await page.waitForLoadState("networkidle", { timeout: Math.min(25_000, timeoutMs()) });
  } catch {
    /* ignore */
  }
  console.error(`    Открыто: ${page.url()}`);

  await pause(rl, "Шаг 2: при необходимости раскройте на странице блок «Аукционные документы» (вручную или жмите Enter — скрипт попробует клики).");
  const skipDoc =
    process.env.LENA_ICETRADE_PLAYWRIGHT_SKIP_DOC_UI_CLICKS?.trim() === "1" ||
    process.env.LENA_ICETRADE_PLAYWRIGHT_SKIP_DOC_UI_CLICKS?.toLowerCase() === "true";
  if (!skipDoc) {
    const clickTargets = [
      page.getByRole("tab", { name: /документ/i }),
      page.getByRole("link", { name: /аукционные\s+документы/i }),
      page.getByText(/^входные\s+документы$/i),
      page.locator("a, button").filter({ hasText: /документы\s+заказчика|конкурсные\s+документы|вк\s*ложен/i }),
    ];
    for (const loc of clickTargets) {
      try {
        const el = loc.first();
        await el.waitFor({ state: "visible", timeout: 2500 });
        await el.click({ timeout: 3000 });
        console.error("    Клик по вкладке/ссылке документов.");
        await new Promise((r) => setTimeout(r, 2500));
        break;
      } catch {
        /* next */
      }
    }
  }

  try {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((r) => setTimeout(r, 800));
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch {
    /* ignore */
  }

  if (!viewId) {
    console.error("Не удалось определить view id из URL — клик по getFile пропущен.");
    await pause(rl, "Шаг 3: закройте окно или Enter для выхода.");
    process.exit(0);
  }

  const nIdx = Number.parseInt(nParam, 10);
  const exactLoc = page.locator(
    `a[href*="/auction/getFile/"][href*="${viewId}"][href*="n=${nParam}"], a[href*="/getFile/"][href*="${viewId}"][href*="n=${nParam}"]`,
  );
  /** @type {import("playwright").Locator} */
  let link;
  if ((await exactLoc.count()) > 0) {
    link = exactLoc.first();
  } else {
    const loose = page.locator(`a[href*="getFile"][href*="${viewId}"], a[href*="GetFile"][href*="${viewId}"]`);
    const cnt = await loose.count();
    console.error(`    Найдено ссылок getFile на карточке: ${cnt}`);
    const idx = Number.isFinite(nIdx) && nIdx >= 0 && nIdx < cnt ? nIdx : 0;
    link = loose.nth(idx);
  }

  await pause(rl, `Шаг 3a: клик по док-ссылке в таблице (n=${nParam}). Часто открывается «Загрузка файла».`);

  await link.scrollIntoViewIfNeeded().catch(() => {});
  await link.waitFor({ state: "visible", timeout: 20_000 });

  const tableLinkFilename = await readIceTradeLinkSiteFilename(link);
  /** @type {string | null} */
  let modalLinkFilename = null;

  const fileUrlGuess = `https://icetrade.by/auction/getFile/auction/${viewId}?f=detail&n=${nParam}`;
  const respPredicate = (/** @type {import('playwright').Response} */ r) => {
    const u = r.url();
    if (!/\/auction\/getFile\//i.test(u) || !u.includes(viewId)) return false;
    if (r.status() < 200 || r.status() >= 400) return false;
    try {
      const sp = new URL(u).searchParams.get("n");
      if (sp === null || sp === "") return true;
      return sp === nParam;
    } catch {
      return true;
    }
  };

  const t = timeoutMs();
  const firstWaitMs = Math.min(18_000, t);
  const modalHeading = page.getByText(/Загрузка\s+файла/i).first();

  const pResp = page
    .waitForResponse(respPredicate, { timeout: firstWaitMs })
    .then((r) => /** @type {const} */ (["resp", r]))
    .catch(() => /** @type {const} */ (["none", null]));
  const pDl = page
    .waitForEvent("download", { timeout: firstWaitMs })
    .then((d) => /** @type {const} */ (["dl", d]))
    .catch(() => /** @type {const} */ (["none", null]));
  const pModal = modalHeading
    .waitFor({ state: "visible", timeout: firstWaitMs })
    .then(() => /** @type {const} */ (["modal", null]))
    .catch(() => /** @type {const} */ (["none", null]));

  await link.click({ timeout: 20_000 });

  const [tag, payload] = await Promise.race([pResp, pDl, pModal]);

  /** @type {{ kind: "resp"; r: import("playwright").Response } | { kind: "dl"; d: import("playwright").Download } | null} */
  let winner = null;
  if (tag === "resp" && payload) {
    winner = { kind: "resp", r: /** @type {import("playwright").Response} */ (payload) };
  } else if (tag === "dl" && payload) {
    winner = { kind: "dl", d: /** @type {import("playwright").Download} */ (payload) };
  }

  if (
    !winner &&
    (tag === "modal" || (await modalHeading.isVisible().catch(() => false)))
  ) {
    await pause(rl, "Шаг 3b: в модалке «Загрузка файла» сейчас кликну по ссылке PDF (финальная загрузка).");
    await new Promise((r) => setTimeout(r, 400));
    const innerLink = await resolveIceTradeModalPdfLink(page, viewId, nParam);
    if (innerLink) {
      modalLinkFilename = await readIceTradeLinkSiteFilename(innerLink);
      await innerLink.scrollIntoViewIfNeeded().catch(() => {});
      const innerResp = page
        .waitForResponse(respPredicate, { timeout: t })
        .then((r) => /** @type {const} */ ({ kind: "resp", r }))
        .catch(() => /** @type {const} */ ({ kind: "none" }));
      const innerDl = page
        .waitForEvent("download", { timeout: t })
        .then((d) => /** @type {const} */ ({ kind: "dl", d }))
        .catch(() => /** @type {const} */ ({ kind: "none" }));
      const innerPop = page
        .waitForEvent("popup", { timeout: t })
        .then((p) => /** @type {const} */ ({ kind: "pop", p }))
        .catch(() => /** @type {const} */ ({ kind: "none" }));
      await clickIceTradeModalLinkReliable(innerLink);
      const w2 = await Promise.race([innerResp, innerDl, innerPop]);
      if (w2.kind === "resp" || w2.kind === "dl") winner = w2;
      else if (w2.kind === "pop") {
        const pop = /** @type {{ kind: "pop"; p: import("playwright").Page }} */ (w2).p;
        try {
          const r2 = await pop.waitForResponse(respPredicate, { timeout: t }).catch(() => null);
          if (r2) winner = { kind: "resp", r: r2 };
        } finally {
          await pop.close().catch(() => {});
        }
      }
    } else {
      console.error("    Не нашёл ссылку PDF внутри модалки — проверьте селекторы.");
    }
  }

  if (!winner) {
    const pop = await page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
    if (pop) {
      console.error(`    Открылась новая вкладка: ${pop.url()}`);
      await pop.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      await pop.close().catch(() => {});
    }
  }

  if (winner?.kind === "resp") {
    const buf = Buffer.from(await winner.r.body());
    const ct = winner.r.headers()["content-type"] || "";
    console.error(`    Ответ getFile: ${buf.length} байт, Content-Type: ${ct || "(нет)"}`);
    console.error(`    Сигнатура: ${buf.subarray(0, 5).toString("latin1")}`);
  } else if (winner?.kind === "dl") {
    const domHint = modalLinkFilename ?? tableLinkFilename;
    let saved = "(не удалось сохранить)";
    try {
      saved = await persistIceTradePlaywrightDownload(winner.d, domHint, viewId || undefined);
    } catch {
      const p = await winner.d.path().catch(() => null);
      saved = p || winner.d.suggestedFilename() || saved;
    }
    console.error(`    Скачивание → ${saved}`);
    console.error(`    Папка загрузок контекста: ${getPlaywrightDownloadsDir(viewId || undefined)}`);
  } else {
    console.error("    Не поймали ответ getFile ни как документ, ни как download — смотрите окно браузера.");
  }

  console.error(`\nОжидаемый URL файла (для сверки): ${fileUrlGuess}`);
  await pause(rl, "Готово. Enter — закрыть браузер.");
  await context.close();
} catch (e) {
  console.error("Ошибка:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  rl.close();
  if (browser) await browser.close().catch(() => {});
}
