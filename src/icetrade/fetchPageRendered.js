import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
 * Referer для GET вложения (как в bootstrapDrive).
 * @param {string} fileUrl
 * @param {string} iceCardPageUrl
 */
function refererForIceTradeFileUrl(fileUrl, iceCardPageUrl) {
  try {
    const u = new URL(fileUrl);
    const host = u.hostname.replace(/^www\./i, "");
    if (host === "goszakupki.by" || host.endsWith(".goszakupki.by")) {
      return `${u.origin}/`;
    }
  } catch {
    /* ignore */
  }
  return iceCardPageUrl;
}

/**
 * @param {import('playwright').BrowserContextOptions} ctxOpts
 */
function mergeIcetradeCookieIntoContext(ctxOpts) {
  const cookie = process.env.LENA_ICETRADE_COOKIE?.trim();
  if (!cookie) return;
  const prev = ctxOpts.extraHTTPHeaders && typeof ctxOpts.extraHTTPHeaders === "object" ? ctxOpts.extraHTTPHeaders : {};
  ctxOpts.extraHTTPHeaders = { ...prev, Cookie: cookie };
}

/**
 * Ожидается бинарь (PDF и т.д.), а не HTML-заглушка (в т.ч. /auction/getFile/… без .pdf в URL).
 * @param {string} fileUrl
 * @param {Buffer} buffer
 * @param {string | null} contentType
 */
function iceTradeBinaryLooksLikeHtmlInsteadOfAttachment(fileUrl, buffer, contentType) {
  if (contentType?.includes("text/html")) return true;
  const low = fileUrl.toLowerCase();
  const expectPdf =
    low.endsWith(".pdf") || low.includes("/getfile") || low.includes("getfile") || /[?&]f=detail\b/i.test(low);
  if (!expectPdf || buffer.length < 8) return false;
  const sig = buffer.subarray(0, 5).toString("latin1");
  if (sig.startsWith("%PDF")) return false;
  const head = buffer
    .subarray(0, Math.min(500, buffer.length))
    .toString("utf8")
    .trimStart()
    .toLowerCase();
  return head.startsWith("<") || head.includes("<!doctype") || head.includes("<html");
}

/**
 * Заголовки ближе к навигации из карточки (иногда APIRequest без них отдаёт HTML).
 * Для icetrade `/auction/getFile/` пробуем **navigate**-стиль (как клик по ссылке), не cors.
 * @param {string} fileUrl
 * @param {string} iceCardPageUrl
 */
function browserLikeGetFileHeaders(fileUrl, iceCardPageUrl) {
  const referer = refererForIceTradeFileUrl(fileUrl, iceCardPageUrl);
  let origin = "https://icetrade.by";
  try {
    origin = new URL(fileUrl).origin;
  } catch {
    /* ignore */
  }
  const low = fileUrl.toLowerCase();
  const isIceTradeGetFile =
    /icetrade\.by/i.test(fileUrl) && (low.includes("/auction/getfile/") || low.includes("/getfile/"));
  if (isIceTradeGetFile) {
    return {
      Referer: referer,
      Accept: "*/*",
      "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.4",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-User": "?1",
    };
  }
  return {
    Referer: referer,
    Accept: "*/*",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.4",
    Origin: origin,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

/**
 * TLS: на части Windows/прокси Playwright падает с «unable to verify the first certificate».
 * По умолчанию ignoreHTTPSErrors; строго: **LENA_ICETRADE_PLAYWRIGHT_IGNORE_TLS_ERRORS=0**
 */
function playwrightIgnoreTlsErrors() {
  const v = process.env.LENA_ICETRADE_PLAYWRIGHT_IGNORE_TLS_ERRORS?.trim().toLowerCase() ?? "";
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

/**
 * Как на fetchPageRendered: попытка раскрыть «Аукционные документы» / вкладки.
 * @param {import('playwright').Page} page
 * @param {number} timeoutMs
 */
async function tryRevealIceTradeDocLinks(page, timeoutMs) {
  const skip =
    process.env.LENA_ICETRADE_PLAYWRIGHT_SKIP_DOC_UI_CLICKS?.trim() === "1" ||
    process.env.LENA_ICETRADE_PLAYWRIGHT_SKIP_DOC_UI_CLICKS?.toLowerCase() === "true";
  if (skip) return;
  const clickTargets = [
    page.getByRole("tab", { name: /документ/i }),
    page.getByRole("link", { name: /аукционные\s+документы/i }),
    page.getByText(/^входные\s+документы$/i),
    page.locator("a, button").filter({ hasText: /документы\s+заказчика|конкурсные\s+документы|вк\s*ложен/i }),
  ];
  for (const loc of clickTargets) {
    try {
      const el = loc.first();
      await el.waitFor({ state: "visible", timeout: Math.min(2500, timeoutMs) });
      await el.click({ timeout: 3000 });
      await sleep(2500);
      break;
    } catch {
      /* next */
    }
  }
}

/**
 * Публичный getFile часто отдаёт PDF только после **клика** со страницы карточки (как у пользователя).
 * @param {import('playwright').BrowserContext} context
 * @param {number} timeoutMs
 * @param {string} fileUrl
 * @param {string} iceCardPageUrl
 * @returns {Promise<{ buffer: Buffer, contentType: string | null, contentDisposition: string | null } | null>}
 */
async function tryIceTradeGetFileViaCardClick(context, timeoutMs, fileUrl, iceCardPageUrl) {
  const viewMatch = /\/(?:tenders\/all\/)?view\/(\d+)/i.exec(iceCardPageUrl);
  const viewId = viewMatch?.[1] ?? "";
  let nParam = "";
  try {
    nParam = new URL(fileUrl).searchParams.get("n") ?? "";
  } catch {
    /* ignore */
  }
  if (!viewId || nParam === "") return null;

  const pg = await context.newPage();
  const clickTimeout = Math.min(timeoutMs, 90_000);
  try {
    await pg.goto(iceCardPageUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    try {
      await pg.waitForLoadState("networkidle", { timeout: Math.min(25_000, timeoutMs) });
    } catch {
      /* SPA */
    }
    try {
      await pg.getByText(/Аукционные\s+документы/i).first().waitFor({ timeout: 12_000 });
    } catch {
      /* ignore */
    }
    await tryRevealIceTradeDocLinks(pg, timeoutMs);
    try {
      await pg.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(800);
      await pg.evaluate(() => window.scrollTo(0, 0));
    } catch {
      /* ignore */
    }
    const settleClick = Math.max(
      500,
      Number.parseInt(process.env.LENA_ICETRADE_PLAYWRIGHT_CLICK_SETTLE_MS?.trim() ?? "2500", 10) ||
        2500,
    );
    await sleep(settleClick);

    const exactLoc = pg.locator(
      `a[href*="/auction/getFile/"][href*="${viewId}"][href*="n=${nParam}"], a[href*="/getFile/"][href*="${viewId}"][href*="n=${nParam}"]`,
    );
    const nIdx = Number.parseInt(nParam, 10);
    /** @type {import("playwright").Locator} */
    let link;
    if ((await exactLoc.count()) > 0) {
      link = exactLoc.first();
    } else {
      const loose = pg.locator(`a[href*="getFile"][href*="${viewId}"], a[href*="GetFile"][href*="${viewId}"]`);
      const cnt = await loose.count();
      const idx = Number.isFinite(nIdx) && nIdx >= 0 && nIdx < cnt ? nIdx : 0;
      link = loose.nth(idx);
    }

    await link.scrollIntoViewIfNeeded().catch(() => {});
    await link.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});

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

    const respP = pg.waitForResponse(respPredicate, { timeout: clickTimeout }).then((r) => ({
      kind: /** @type {const} */ ("resp"),
      r,
    }));
    const dlP = pg.waitForEvent("download", { timeout: clickTimeout }).then((d) => ({
      kind: /** @type {const} */ ("dl"),
      d,
    }));

    await link.click({ timeout: 15_000 });

    /** @type {{ kind: "resp"; r: import("playwright").Response } | { kind: "dl"; d: import("playwright").Download } | null} */
    let winner = await Promise.race([respP, dlP]).catch(() => null);

    if (!winner) {
      const pop = await pg.waitForEvent("popup", { timeout: 3000 }).catch(() => null);
      if (pop) {
        try {
          const r2 = await pop.waitForResponse(respPredicate, { timeout: clickTimeout }).catch(() => null);
          if (r2) winner = { kind: "resp", r: r2 };
        } finally {
          await pop.close().catch(() => {});
        }
      }
    }

    if (winner?.kind === "resp") {
      const gotResp = winner.r;
      const buf = Buffer.from(await gotResp.body());
      const h = gotResp.headers();
      const rawCt = h["content-type"];
      const ct = rawCt ? rawCt.split(";")[0].trim().toLowerCase() : null;
      const rawCd = h["content-disposition"];
      const cd = rawCd !== undefined && rawCd !== null ? String(rawCd) : null;
      if (!iceTradeBinaryLooksLikeHtmlInsteadOfAttachment(fileUrl, buf, ct) && buf.length >= 16) {
        return { buffer: buf, contentType: ct, contentDisposition: cd };
      }
    } else if (winner?.kind === "dl") {
      const p = await winner.d.path();
      if (p) {
        const buf = await readFile(p);
        const ctGuess = winner.d.suggestedFilename()?.toLowerCase().endsWith(".pdf") ? "application/pdf" : null;
        if (!iceTradeBinaryLooksLikeHtmlInsteadOfAttachment(fileUrl, buf, ctGuess) && buf.length >= 16) {
          return { buffer: buf, contentType: ctGuess, contentDisposition: null };
        }
      }
    }

    return null;
  } finally {
    await pg.close();
  }
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {number} timeoutMs
 * @param {string} fileUrl
 * @param {string} iceCardPageUrl
 */
async function fetchBinaryViaPlaywrightContext(context, timeoutMs, fileUrl, iceCardPageUrl) {
  const hdrs = browserLikeGetFileHeaders(fileUrl, iceCardPageUrl);
  const resp = await context.request.get(fileUrl, {
    headers: hdrs,
    timeout: timeoutMs,
  });
  const status = resp.status();
  if (status < 200 || status >= 400) {
    throw new Error(`HTTP ${status}`);
  }
  /** @type {Buffer} */
  let buffer = Buffer.from(await resp.body());
  const h = resp.headers();
  const rawCt = h["content-type"];
  let contentType = rawCt ? rawCt.split(";")[0].trim().toLowerCase() : null;
  const rawCd = h["content-disposition"];
  let contentDisposition = rawCd !== undefined && rawCd !== null ? String(rawCd) : null;

  if (iceTradeBinaryLooksLikeHtmlInsteadOfAttachment(fileUrl, buffer, contentType)) {
    const referer = refererForIceTradeFileUrl(fileUrl, iceCardPageUrl);
    const tryApplyNavResponse = async (nav) => {
      if (!nav || !nav.ok()) return false;
      const b2 = Buffer.from(await nav.body());
      const nh = nav.headers();
      const nctRaw = nh["content-type"];
      const ct2 = nctRaw ? nctRaw.split(";")[0].trim().toLowerCase() : null;
      const ncd = nh["content-disposition"];
      if (!iceTradeBinaryLooksLikeHtmlInsteadOfAttachment(fileUrl, b2, ct2) && b2.length >= 16) {
        buffer = b2;
        contentType = ct2 ?? contentType;
        contentDisposition =
          ncd !== undefined && ncd !== null ? String(ncd) : contentDisposition;
        return true;
      }
      return false;
    };

    const pg = await context.newPage();
    try {
      let nav = await pg.goto(fileUrl, {
        timeout: timeoutMs,
        waitUntil: "commit",
        referer,
      });
      if (await tryApplyNavResponse(nav)) {
        /* ok */
      } else {
        await pg.goto(iceCardPageUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        await sleep(500);
        nav = await pg.goto(fileUrl, {
          timeout: timeoutMs,
          waitUntil: "commit",
          referer: iceCardPageUrl,
        });
        await tryApplyNavResponse(nav);
      }
    } finally {
      await pg.close();
    }
  }

  if (iceTradeBinaryLooksLikeHtmlInsteadOfAttachment(fileUrl, buffer, contentType)) {
    const viaClick = await tryIceTradeGetFileViaCardClick(context, timeoutMs, fileUrl, iceCardPageUrl);
    if (viaClick) {
      buffer = viaClick.buffer;
      contentType = viaClick.contentType;
      contentDisposition = viaClick.contentDisposition;
    }
  }

  return { buffer, contentType, contentDisposition };
}

/**
 * Один сеанс Chromium: скачивание URL с теми же cookies/storage, что при открытии карточки.
 * Помогает, когда Node-fetch по `getFile` отдаёт HTML вместо PDF, а в обычном браузере тот же файл публичный.
 *
 * Перед GET выполняется **прогрев**: переход на страницу карточки в этом же контексте (куки ответов сервера),
 * иначе `context.request` часто ведёт себя иначе, чем после навигации в той же вкладке.
 *
 * **LENA_ICETRADE_PLAYWRIGHT_FILE_DOWNLOAD** = 0|false|off — не использовать (только Node).
 * **LENA_ICETRADE_PLAYWRIGHT_DOWNLOAD_PRIME_MS** — пауза после открытия карточки при прогреве, мс (по умолчанию 2000).
 * **LENA_ICETRADE_PLAYWRIGHT_CLICK_SETTLE_MS** — пауза на карточке перед кликом по getFile при обходе через UI, мс (по умолчанию 2500).
 *
 * @param {number} timeoutMs
 * @param {string} [primeIceCardPageUrl] — URL карточки IceTrade для однократного `page.goto` перед скачиваниями
 * @param {(api: {{ requestBinary: (fileUrl: string, iceCardPageUrl: string) => Promise<{ buffer: Buffer, contentType: string | null, contentDisposition: string | null }> }}) => Promise<T>} run
 * @returns {Promise<T>}
 * @template T
 */
export async function withPlaywrightIceTradeDownloadBatch(timeoutMs, primeIceCardPageUrl, run) {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error(
      "Пакет playwright не установлен. Выполните: npm install playwright && npx playwright install chromium",
    );
  }

  const storageRaw = process.env.LENA_ICETRADE_PLAYWRIGHT_STORAGE?.trim();
  /** @type {string | undefined} */
  let storagePath;
  if (storageRaw && existsSync(storageRaw)) storagePath = storageRaw;

  const ua =
    process.env.LENA_ICETRADE_USER_AGENT?.trim() ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  const browser = await playwright.chromium.launch({
    headless: process.env.LENA_ICETRADE_PLAYWRIGHT_HEADED?.trim() === "1" ? false : true,
  });

  try {
    /** @type {import('playwright').BrowserContextOptions} */
    const ctxOpts = {
      acceptDownloads: true,
      userAgent: ua,
      locale: "ru-RU",
      ignoreHTTPSErrors: playwrightIgnoreTlsErrors(),
      extraHTTPHeaders: {
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.4",
      },
    };
    mergeIcetradeCookieIntoContext(ctxOpts);
    if (storagePath) ctxOpts.storageState = storagePath;

    const context = await browser.newContext(ctxOpts);

    const prime = typeof primeIceCardPageUrl === "string" ? primeIceCardPageUrl.trim() : "";
    const primeMs = Math.max(
      0,
      Number.parseInt(process.env.LENA_ICETRADE_PLAYWRIGHT_DOWNLOAD_PRIME_MS?.trim() ?? "2000", 10) || 2000,
    );
    if (prime) {
      const warm = await context.newPage();
      try {
        await warm.goto(prime, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        if (primeMs > 0) await sleep(primeMs);
      } catch {
        /* прогрев необязателен — дальше всё равно пробуем скачивание */
      } finally {
        await warm.close();
      }
    }

    /**
     * @param {string} fileUrl
     * @param {string} iceCardPageUrl
     */
    const requestBinary = async (fileUrl, iceCardPageUrl) => {
      return fetchBinaryViaPlaywrightContext(context, timeoutMs, fileUrl, iceCardPageUrl);
    };

    return await run({ requestBinary });
  } finally {
    await browser.close();
  }
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
 *   LENA_ICETRADE_PLAYWRIGHT_STORAGE — опционально: путь к JSON после `npm run icetrade:playwright-auth` (куки как у браузера)
 *   LENA_ICETRADE_COOKIE — опционально: Cookie заголовок из DevTools (дублируется в контексте)
 *   LENA_ICETRADE_PLAYWRIGHT_SETTLE_MS — пауза после load, мс (по умолчанию 6000)
 *   LENA_ICETRADE_PLAYWRIGHT_HEADED=1 — окно браузера (отладка)
 *   LENA_ICETRADE_PLAYWRIGHT_MAX_RESPONSE_BYTES — разбор тел ответов JSON до N байт (по умолчанию 4000000)
 *   LENA_ICETRADE_PLAYWRIGHT_SKIP_DOC_UI_CLICKS=1 — не кликать по вкладкам/ссылкам документов (если блок уже открыт)
 *   LENA_ICETRADE_PLAYWRIGHT_FILE_DOWNLOAD=0 — не качать вложения через Playwright при bootstrap (только Node)
 *   LENA_ICETRADE_PLAYWRIGHT_DOWNLOAD_PRIME_MS — пауза после прогрева карточки перед скачиванием вложений (по умолчанию 2000)
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
        `**LENA_ICETRADE_PLAYWRIGHT_STORAGE:** нет файла \`${storageRaw}\` — запуск **без** сохранённых кук. Создайте JSON через \`npm run icetrade:playwright-auth\` или уберите переменную.`,
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
      acceptDownloads: true,
      userAgent: ua,
      locale: "ru-RU",
      ignoreHTTPSErrors: playwrightIgnoreTlsErrors(),
      extraHTTPHeaders: {
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.4",
      },
    };
    mergeIcetradeCookieIntoContext(ctxOpts);
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
      /* ссылки только в JSON / позже в DOM */
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
