import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Из текста JSON/HTML ответа — URL файлов: icetrade.by (по расширению) и goszakupki.by /auction/get-file/.
 * @param {string} text
 */
function collectIceTradeFileUrlsFromText(text) {
  if (!text || text.length > 5_000_000) return [];
  /** @type {Set<string>} */
  const set = new Set();
  const abs =
    /https?:\/\/(?:www\.)?icetrade\.by[-a-z0-9+&@#/%?=~_|!:,.;]*\.(?:pdf|docx?|zip|rar|7z|xlsx?|csv|txt)(?:\?[-a-z0-9+&@#/%?=~_|!:,.;]*)?/gi;
  let m;
  while ((m = abs.exec(text)) !== null) set.add(m[0]);

  const absGosz =
    /https?:\/\/(?:www\.)?goszakupki\.by\/auction\/get-file\/\d+[-a-z0-9+&@#/%?=~_|!:,.;]*/gi;
  while ((m = absGosz.exec(text)) !== null) set.add(m[0]);

  const rel = /["'](\/[-a-z0-9+&@#/%?=~_|!:,.;]*\.(?:pdf|docx?|zip|rar|7z|xlsx?|csv|txt)(?:\?[^"'\\]*)?)["']/gi;
  while ((m = rel.exec(text)) !== null) {
    try {
      set.add(new URL(m[1], "https://icetrade.by").href);
    } catch {
      /* ignore */
    }
  }
  return Array.from(set);
}

/**
 * HTML карточки IceTrade после выполнения JS в Chromium (Playwright).
 *
 * Установка:
 *   npm install
 *   npx playwright install chromium
 *
 * Переменные:
 *   LENA_ICETRADE_PLAYWRIGHT=1 — включить вместо «голого» HTTP при bootstrap
 *   LENA_ICETRADE_PLAYWRIGHT_STORAGE — путь к JSON сессии (см. npm run icetrade:playwright-auth)
 *   LENA_ICETRADE_PLAYWRIGHT_SETTLE_MS — пауза после load, мс (по умолчанию 6000)
 *   LENA_ICETRADE_PLAYWRIGHT_HEADED=1 — окно браузера (отладка)
 *   LENA_ICETRADE_PLAYWRIGHT_MAX_RESPONSE_BYTES — разбор тел ответов JSON до N байт (по умолчанию 4000000)
 *   LENA_ICETRADE_PLAYWRIGHT_SKIP_DOC_UI_CLICKS=1 — не кликать по вкладкам/ссылкам документов (если блок уже открыт)
 *
 * @param {string} pageUrl
 * @param {number} timeoutMs
 * @returns {Promise<{ html: string, via: string, networkFileUrls: string[], warnings?: string[] }>}
 */
export async function fetchPageRendered(pageUrl, timeoutMs) {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error(
      "Пакет playwright не установлен. Выполните: npm install playwright && npx playwright install chromium",
    );
  }

  const settleMs = Math.max(
    0,
    Number.parseInt(process.env.LENA_ICETRADE_PLAYWRIGHT_SETTLE_MS?.trim() ?? "6000", 10) || 6000,
  );
  const maxBody =
    Number.parseInt(process.env.LENA_ICETRADE_PLAYWRIGHT_MAX_RESPONSE_BYTES?.trim() ?? "4000000", 10) ||
    4_000_000;
  const storageRaw = process.env.LENA_ICETRADE_PLAYWRIGHT_STORAGE?.trim();
  /** @type {string[]} */
  const warnings = [];
  /** @type {string | undefined} */
  let storagePath;
  if (storageRaw) {
    if (existsSync(storageRaw)) {
      storagePath = storageRaw;
    } else {
      warnings.push(
        `**LENA_ICETRADE_PLAYWRIGHT_STORAGE:** нет файла \`${storageRaw}\` — запуск **без** сессии ЛК. Создайте: \`npm run icetrade:playwright-auth -- путь.json\` или уберите переменную.`,
      );
    }
  }
  const ua =
    process.env.LENA_ICETRADE_USER_AGENT?.trim() ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  const browser = await playwright.chromium.launch({
    headless: process.env.LENA_ICETRADE_PLAYWRIGHT_HEADED?.trim() === "1" ? false : true,
  });

  /** @type {Set<string>} */
  const networkFileUrls = new Set();

  try {
    /** @type {import('playwright').BrowserContextOptions} */
    const ctxOpts = {
      userAgent: ua,
      locale: "ru-RU",
      extraHTTPHeaders: {
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.4",
      },
    };
    if (storagePath) {
      ctxOpts.storageState = storagePath;
    }

    const context = await browser.newContext(ctxOpts);
    const page = await context.newPage();

    page.on("response", (response) => {
      void (async () => {
        try {
          const u = response.url();
          if (!/icetrade\.by/i.test(u) && !/goszakupki\.by/i.test(u)) return;
          const status = response.status();
          if (status < 200 || status >= 300) return;
          const headers = response.headers();
          const cl = headers["content-length"];
          if (cl && Number.parseInt(cl, 10) > maxBody) return;
          const ct = (headers["content-type"] || "").toLowerCase();
          if (
            !ct.includes("json") &&
            !ct.includes("javascript") &&
            !ct.includes("text/plain") &&
            !ct.includes("xml")
          ) {
            return;
          }
          const text = await response.text();
          if (text.length > maxBody) return;
          for (const x of collectIceTradeFileUrlsFromText(text)) networkFileUrls.add(x);
        } catch {
          /* тело уже прочитано или обрыв */
        }
      })();
    });

    const navTimeout = Math.max(15_000, timeoutMs);
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: navTimeout });
    try {
      await page.waitForLoadState("networkidle", { timeout: Math.min(25_000, navTimeout) });
    } catch {
      /* SPA без остановки сети */
    }

    try {
      await page.getByText(/Аукционные\s+документы/i).first().waitFor({ timeout: 12_000 });
    } catch {
      /* блок может называться иначе или позже */
    }

    /** Если блок «Аукционные документы» всегда развёрнут — LENA_ICETRADE_PLAYWRIGHT_SKIP_DOC_UI_CLICKS=1 (не кликать по вкладкам). */
    const skipDocUiClicks =
      process.env.LENA_ICETRADE_PLAYWRIGHT_SKIP_DOC_UI_CLICKS?.trim() === "1" ||
      process.env.LENA_ICETRADE_PLAYWRIGHT_SKIP_DOC_UI_CLICKS?.toLowerCase() === "true";
    if (!skipDocUiClicks) {
      /** Попытка открыть вкладку/ссылку с документами (на ЭТП блок может быть свёрнут). */
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
          await sleep(2500);
          break;
        } catch {
          /* next */
        }
      }
    }

    try {
      await page
        .locator(
          'a[href*=".pdf"], a[href*=".PDF"], a[href*=".doc"], a[href*="download"], a[href*="attach"], a[href*="file"]',
        )
        .first()
        .waitFor({ state: "visible", timeout: 18_000 });
    } catch {
      /* ссылки только в JSON или после входа */
    }

    try {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(1200);
      await page.evaluate(() => window.scrollTo(0, 0));
    } catch {
      /* ignore */
    }

    if (settleMs > 0) {
      await sleep(settleMs);
    }

    const html = await page.content();
    const networkFileUrlsArr = Array.from(networkFileUrls);
    return {
      html,
      via: "playwright",
      networkFileUrls: networkFileUrlsArr,
      ...(warnings.length ? { warnings } : {}),
    };
  } finally {
    await browser.close();
  }
}

/**
 * @returns {boolean}
 */
export function iceTradePlaywrightEnabled() {
  const v = process.env.LENA_ICETRADE_PLAYWRIGHT?.trim().toLowerCase() ?? "";
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Старое имя — то же, что {@link fetchPageRendered} (bootstrap, CLI). */
export { fetchPageRendered as fetchIceTradeCardHtmlPlaywright };
