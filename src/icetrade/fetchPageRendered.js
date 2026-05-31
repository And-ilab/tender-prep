import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { readFile, readdir, writeFile, rm, unlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { tenderFolderName } from "../drive/layoutConstants.js";
import { normalizeIceTradeViewId } from "./viewIds.js";

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
 * **LENA_ICETRADE_PLAYWRIGHT_SKIP_DOWNLOAD_PRIME** — отдельная вкладка «прогрев карточки» перед батчем в `withPlaywrightIceTradeDownloadBatch`.
 * По умолчанию **вкладка прогрева отключена**: сначала идут прямые запросы к файлам; при необходимости срабатывает
 * **tryIceTradeGetFileViaCardClick** (как в UI: **страница тендера → модалка «Загрузка файла» → скачивание**).
 * Явно включить старый прогрев: `LENA_ICETRADE_PLAYWRIGHT_SKIP_DOWNLOAD_PRIME=0` (или false/off).
 */
export function iceTradePlaywrightSkipDownloadPrime() {
  const v = process.env.LENA_ICETRADE_PLAYWRIGHT_SKIP_DOWNLOAD_PRIME?.trim().toLowerCase() ?? "";
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  return true;
}

/**
 * Общий каталог Chromium для службы Windows (SYSTEM) и интерактивного пользователя.
 * Задайте **LENA_PLAYWRIGHT_BROWSERS_PATH** или **PLAYWRIGHT_BROWSERS_PATH** в `.env`.
 * @returns {string | undefined}
 */
export function ensurePlaywrightBrowsersPathEnv() {
  const explicit =
    process.env.LENA_PLAYWRIGHT_BROWSERS_PATH?.trim() ||
    process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (explicit) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = explicit;
    return explicit;
  }
  /** @type {string[]} */
  const candidates = [
    "C:\\ProgramData\\ms-playwright",
    join(process.env.LOCALAPPDATA || "", "ms-playwright"),
    join(process.env.USERPROFILE || "", "AppData", "Local", "ms-playwright"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && existsSync(c)) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = c;
      return c;
    }
  }
  return undefined;
}

/**
 * Есть ли установленный Chromium для Playwright (иначе launch падает на службе Windows).
 * @returns {boolean}
 */
export function playwrightChromiumLikelyInstalled() {
  ensurePlaywrightBrowsersPathEnv();
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (!base || !existsSync(base)) return false;
  try {
    /** @param {string} dir */
    const walk = (dir, depth = 0) => {
      if (depth > 4) return false;
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name);
        if (name.isFile()) {
          const low = name.name.toLowerCase();
          if (low === "chrome-headless-shell.exe" || low === "chrome.exe") return true;
        } else if (name.isDirectory()) {
          if (walk(p, depth + 1)) return true;
        }
      }
      return false;
    };
    return walk(base);
  } catch {
    return false;
  }
}

/**
 * LENA_ICETRADE_PLAYWRIGHT_HEADED=1 — видимое окно.
 * LENA_ICETRADE_PLAYWRIGHT_SLOW_MO_MS — замедление действий (мс), удобно для демонстрации.
 * @returns {import("playwright").LaunchOptions}
 */
function resolvePlaywrightLaunchOptions() {
  ensurePlaywrightBrowsersPathEnv();
  const headed = process.env.LENA_ICETRADE_PLAYWRIGHT_HEADED?.trim() === "1";
  const slowMo = Math.max(
    0,
    Number.parseInt(process.env.LENA_ICETRADE_PLAYWRIGHT_SLOW_MO_MS?.trim() ?? "0", 10) || 0,
  );
  /** @type {import("playwright").LaunchOptions} */
  const o = { headless: !headed };
  if (slowMo > 0) o.slowMo = slowMo;
  return o;
}

/**
 * Маркер «последняя ежедневная уборка» в корне {@link getPlaywrightDownloadsBaseDir}.
 * Файлы вида `viewId/` — подкаталоги закупки; раз в **локальный календарный день** удаляется всё,
 * кроме этого маркера (см. {@link maybeCleanupPlaywrightDownloadsBase}).
 */
const PLAYWRIGHT_DL_HOUSEKEEPING_MARKER = ".lena-playwright-dl-last-clean";

function playwrightDownloadsDailyCleanupDisabled() {
  const v =
    process.env.LENA_ICETRADE_PLAYWRIGHT_DOWNLOADS_SKIP_DAILY_CLEANUP?.trim().toLowerCase() ?? "";
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Если корень загрузок Playwright совпадает с системным TEMP — ежедневная «уборка» удалит чужие каталоги,
 * в т.ч. **lena-ice-*** из `mkdtemp` при импорте IceTrade → ENOENT при записи файлов во временном каталоге.
 */
async function playwrightDownloadsBaseCollidesWithOsTemp(baseAbs) {
  try {
    const [rb, rt] = await Promise.all([realpath(baseAbs), realpath(tmpdir())]);
    return rb === rt;
  } catch {
    try {
      return resolve(baseAbs) === resolve(tmpdir());
    } catch {
      return false;
    }
  }
}

/** @returns {string} YYYY-MM-DD в локальной таймзоне процесса */
function localCalendarDayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Корень каталога загрузок Playwright (без подпапки закупки).
 *
 * **LENA_ICETRADE_PLAYWRIGHT_DOWNLOADS_DIR** — каталог относительно cwd или абсолютный
 * (удобно задать путь на диске C:); по умолчанию `<cwd>/playwright-downloads`.
 *
 * @returns {string}
 */
export function getPlaywrightDownloadsBaseDir() {
  const raw = process.env.LENA_ICETRADE_PLAYWRIGHT_DOWNLOADS_DIR?.trim();
  return raw && raw.length > 0 ? resolve(process.cwd(), raw) : resolve(process.cwd(), "playwright-downloads");
}

/**
 * Если не задать downloadsPath, Playwright кладёт файлы во временный каталог и **удаляет** их при закрытии контекста.
 *
 * При непустом **viewId** файлы пишутся в **`&lt;base&gt;/&lt;safeViewId&gt;/`** — чтобы параллельные закупки не делили одну кучу имён.
 *
 * **LENA_ICETRADE_PLAYWRIGHT_DOWNLOADS_SKIP_DAILY_CLEANUP** — не чистить корень **base** раз в сутки (см. {@link maybeCleanupPlaywrightDownloadsBase}).
 *
 * @param {string | null | undefined} [viewId]
 * @returns {string}
 */
export function getPlaywrightDownloadsDir(viewId) {
  const base = getPlaywrightDownloadsBaseDir();
  if (viewId === undefined || viewId === null || String(viewId).trim() === "") {
    return base;
  }
  const id = normalizeIceTradeViewId(String(viewId)) ?? String(viewId).trim();
  if (!id) return base;
  return join(base, tenderFolderName(id));
}

/**
 * Раз в **локальный календарный день**: удалить всё содержимое {@link getPlaywrightDownloadsBaseDir},
 * кроме файла-маркера (подкаталоги закупок и прочий мусор). Первый вызов Playwright за день
 * после полуночи выполнит уборку до открытия Chromium.
 *
 * @returns {Promise<{ ran: boolean, reason?: string, base?: string }>}
 */
export async function maybeCleanupPlaywrightDownloadsBase() {
  if (playwrightDownloadsDailyCleanupDisabled()) {
    return { ran: false, reason: "disabled_env" };
  }
  const base = getPlaywrightDownloadsBaseDir();
  mkdirSync(base, { recursive: true });
  if (await playwrightDownloadsBaseCollidesWithOsTemp(base)) {
    console.warn(
      "[lena] Пропуск ежедневной очистки Playwright: LENA_ICETRADE_PLAYWRIGHT_DOWNLOADS_DIR указывает на системный TEMP (%s). Задайте отдельную папку (напр. …/playwright-downloads), иначе удаляются временные каталоги bootstrap (**lena-ice-***).",
      resolve(base),
    );
    return { ran: false, reason: "unsafe_same_as_os_tmpdir", base: resolve(base) };
  }
  const today = localCalendarDayYmd();
  const markerPath = join(base, PLAYWRIGHT_DL_HOUSEKEEPING_MARKER);
  try {
    const prev = (await readFile(markerPath, "utf8")).trim();
    if (prev === today) return { ran: false, reason: "already_today" };
  } catch {
    /* первый запуск или нет маркера */
  }
  const entries = await readdir(base, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === PLAYWRIGHT_DL_HOUSEKEEPING_MARKER) continue;
    // Каталоги bootstrap IceTrade в том же родителе (ошибочный env): не удалять.
    if (e.isDirectory() && /^lena-ice-/i.test(e.name)) continue;
    const full = join(base, e.name);
    try {
      if (e.isDirectory()) await rm(full, { recursive: true, force: true });
      else await unlink(full);
    } catch {
      /* занято ОС — пропускаем */
    }
  }
  try {
    await writeFile(markerPath, `${today}\n`, "utf8");
  } catch {
    /* ignore */
  }
  return { ran: true, base };
}
function safeDownloadBasename(name) {
  const s = String(name)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ");
  return (s.slice(0, 180) || "file").trim();
}

/**
 * Имя для сохранения: сначала то, что видно в таблице/модалке на icetrade; иначе то, что сообщил браузер (Content-Disposition / URL), без выдуманных префиксов.
 * @param {string | null | undefined} domHint
 * @param {string | null | undefined} suggested
 */
function pickIceTradePersistedFilename(domHint, suggested) {
  const dom = domHint?.trim();
  if (dom) return safeDownloadBasename(dom);
  const sug = suggested?.trim();
  if (sug) return safeDownloadBasename(sug);
  return safeDownloadBasename("download.bin");
}

/**
 * Человекочитаемое имя файла с карточки: атрибут `download`, текст/строка таблицы с расширением (как на icetrade).
 * @param {import("playwright").Locator} loc
 * @returns {Promise<string | null>}
 */
export async function readIceTradeLinkSiteFilename(loc) {
  const exts = /\.(?:pdf|docx?|zip|rar|7z|xlsx?|csv|txt|pptx?|xml|json)(?:\b|$)/i;

  const downloadAttr = await loc.getAttribute("download").catch(() => null);
  const da = downloadAttr?.trim();
  if (da && da !== "" && !/^https?:/i.test(da)) return safeDownloadBasename(da);

  for (const attr of ["title", "aria-label"]) {
    const v = (await loc.getAttribute(attr).catch(() => null))?.trim();
    if (v && exts.test(v) && !/^https?:/i.test(v)) return safeDownloadBasename(v);
  }

  const text = (await loc.innerText().catch(() => "")).trim().replace(/\s+/g, " ");
  if (text && !/^https?:/i.test(text)) {
    if (exts.test(text)) return safeDownloadBasename(text);
    const m =
      /([^\s\n\r/<>|]+\.(?:pdf|docx?|zip|rar|7z|xlsx?|csv|txt|pptx?|xml|json))\b/i.exec(text);
    if (m) return safeDownloadBasename(m[1]);
  }

  const row = loc.locator("xpath=ancestor::tr[1]");
  if ((await row.count().catch(() => 0)) > 0) {
    const rowText = (await row.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const m =
      /([^\s\n\r/<>|]+\.(?:pdf|docx?|zip|rar|7z|xlsx?|csv|txt|pptx?|xml|json))\b/i.exec(rowText);
    if (m) return safeDownloadBasename(m[1]);
  }

  return null;
}

/**
 * Сохранить событие Playwright `download` в каталоге {@link getPlaywrightDownloadsDir} под именем с площадки (см. {@link readIceTradeLinkSiteFilename}).
 * @param {import("playwright").Download} d
 * @param {string | null | undefined} domHint
 * @param {string | null | undefined} [viewIdForDir] — подпапка закупки; иначе только корень base
 * @returns {Promise<string>} абсолютный путь сохранённого файла
 */
export async function persistIceTradePlaywrightDownload(d, domHint, viewIdForDir) {
  const dir = getPlaywrightDownloadsDir(viewIdForDir ?? undefined);
  mkdirSync(dir, { recursive: true });
  let suggested = null;
  try {
    suggested = d.suggestedFilename();
  } catch {
    suggested = null;
  }
  const base = pickIceTradePersistedFilename(domHint, suggested);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  /** @type {string} */
  let uniqueTarget = join(dir, base);
  let n = 0;
  while (existsSync(uniqueTarget)) {
    n += 1;
    uniqueTarget = join(dir, `${stem}-${n}${ext}`);
  }
  await d.saveAs(uniqueTarget);
  return uniqueTarget;
}

/**
 * @param {import("playwright").BrowserContextOptions} ctxOpts
 * @param {string | null | undefined} [viewIdForDir]
 */
export function applyPlaywrightDownloadsPath(ctxOpts, viewIdForDir) {
  const dir = getPlaywrightDownloadsDir(viewIdForDir ?? undefined);
  mkdirSync(dir, { recursive: true });
  ctxOpts.downloadsPath = dir;
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
 * Окно «Загрузка файла» на icetrade чаще всего jQuery UI / кастомный div без role=dialog.
 * Ссылка внутри может совпадать с табличной по href; предпочитаем контейнер модалки и видимый .pdf.
 * @param {import("playwright").Page} pg
 */
function iceTradeFileDownloadModalRoot(pg) {
  return pg
    .locator(
      [
        "div.ui-dialog.ui-widget-content:visible",
        "div.ui-dialog:visible",
        '[class*="ui-dialog"]:visible',
        "div.modal:visible",
        "div.modal-dialog:visible",
        'div[role="dialog"]:visible',
        '[class*="popup"]:visible',
        '[class*="overlay"] .dialog:visible',
      ].join(", "),
    )
    .filter({ hasText: /Загрузка\s+файла/i })
    .first();
}

/**
 * Ссылка на PDF в модальном окне «Загрузка файла» (первый клик по строке только открывает модалку).
 * @param {import("playwright").Page} pg
 * @param {string} viewId
 * @param {string} nParam
 */
export async function resolveIceTradeModalPdfLink(pg, viewId, nParam) {
  const hrefNeedle = `n=${nParam}`;
  const exactSel = `a[href*="/auction/getFile/"][href*="${viewId}"][href*="${hrefNeedle}"], a[href*="/getFile/"][href*="${viewId}"][href*="${hrefNeedle}"], a[href*="getFile"][href*="${hrefNeedle}"]`;

  try {
    await iceTradeFileDownloadModalRoot(pg).waitFor({ state: "visible", timeout: 12_000 });
  } catch {
    /* модалка уже видна или другая разметка */
  }

  const modal = iceTradeFileDownloadModalRoot(pg);

  /** @param {import("playwright").Locator} scope */
  const pickInScope = async (scope) => {
    const byHref = scope.locator(exactSel).first();
    if ((await byHref.count()) > 0) return byHref;
    const anyGet = scope.locator(`a[href*="getFile"]`).first();
    if ((await anyGet.count()) > 0) return anyGet;
    const byName = scope.getByRole("link", { name: /\.pdf/i }).first();
    if ((await byName.count()) > 0) return byName;
    return null;
  };

  const inModal = await pickInScope(modal);
  if (inModal) return inModal;

  const dialog = pg.getByRole("dialog");
  if ((await dialog.count()) > 0) {
    const x = await pickInScope(dialog);
    if (x) return x;
  }

  for (const frame of pg.frames()) {
    if (frame === pg.mainFrame()) continue;
    try {
      const fModal = iceTradeFileDownloadModalRoot(frame);
      if ((await fModal.count()) > 0) {
        const y = await pickInScope(fModal);
        if (y) return y;
      }
    } catch {
      /* ignore */
    }
  }

  const pdfLinks = pg.getByRole("link", { name: /\.pdf/i });
  const nLinks = await pdfLinks.count();
  for (let i = nLinks - 1; i >= 0; i--) {
    const cand = pdfLinks.nth(i);
    if (!(await cand.isVisible().catch(() => false))) continue;
    const href = await cand.getAttribute("href").catch(() => null);
    if (href && (href.includes(hrefNeedle) || href.includes(encodeURIComponent(`n=${nParam}`)))) return cand;
    if (href && href.includes(viewId) && href.toLowerCase().includes("getfile")) return cand;
  }

  const last = pg.locator(`a[href*="${hrefNeedle}"]`).last();
  if ((await last.count()) > 0) return last;

  const modalLikelyOpen = await pg
    .getByText(/Загрузка\s+файла/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (modalLikelyOpen) {
    for (let i = nLinks - 1; i >= 0; i--) {
      const cand = pdfLinks.nth(i);
      if (await cand.isVisible().catch(() => false)) return cand;
    }
  }

  return null;
}

/**
 * Клик по ссылке в модалке (интерактив слой / асинхронная подстановка href).
 * @param {import("playwright").Locator} loc
 */
export async function clickIceTradeModalLinkReliable(loc) {
  await loc.waitFor({ state: "visible", timeout: 15_000 });
  try {
    await loc.click({ timeout: 12_000, force: true });
  } catch {
    await loc.evaluate((el) => {
      const a = /** @type {HTMLAnchorElement} */ (el);
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      if (a.href && !/^javascript:/i.test(a.href)) a.click();
    });
  }
}

/**
 * Публичный getFile часто отдаёт PDF только после **клика** со страницы карточки (как у пользователя).
 * Флоу как в браузере: **страница тендера** → при необходимости **диалог «Загрузка файла»** → **второй клик** по ссылке на файл → ответ/download.
 * (Отдельный «прогрев» одной вкладкой перед батчем — см. `withPlaywrightIceTradeDownloadBatch`, по умолчанию выкл.)
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

    const tableLinkFilename = await readIceTradeLinkSiteFilename(link);
    /** @type {string | null} */
    let modalLinkFilename = null;

    const matchesGetFileSameLot = (/** @type {import("playwright").Response} */ r) => {
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

    /**
     * Площадка часто отдаёт **первым** ответом по getFile HTML «Главная» (тот же, что у «голого» GET).
     * Promise.race тогда сразу проигрывает на мусорном HTML и не ждёт реальный PDF — ждём ответ, похожий на вложение.
     * @param {import("playwright").Response} r
     */
    const responseLooksLikeAttachment = async (r) => {
      if (!matchesGetFileSameLot(r)) return false;
      const ct = (r.headers()["content-type"] || "").toLowerCase();
      if (ct.includes("text/html")) return false;
      if (ct.includes("application/pdf")) return true;
      try {
        const b = Buffer.from(await r.body());
        if (b.length >= 5 && b.subarray(0, 5).toString("latin1").startsWith("%PDF")) return true;
        if (
          (ct.includes("application/octet-stream") || ct.includes("binary")) &&
          b.length >= 16 &&
          !b
            .subarray(0, Math.min(120, b.length))
            .toString("utf8")
            .trimStart()
            .toLowerCase()
            .startsWith("<")
        ) {
          return true;
        }
      } catch {
        /* тело недоступно */
      }
      return false;
    };

    const firstWaitMs = Math.min(18_000, clickTimeout);
    const modalHeading = pg.getByText(/Загрузка\s+файла/i).first();

    const pResp = pg
      .waitForResponse((r) => responseLooksLikeAttachment(r), { timeout: firstWaitMs })
      .then((r) => /** @type {const} */ (["resp", r]))
      .catch(() => /** @type {const} */ (["none", null]));
    const pDl = pg
      .waitForEvent("download", { timeout: firstWaitMs })
      .then((d) => /** @type {const} */ (["dl", d]))
      .catch(() => /** @type {const} */ (["none", null]));
    const pModal = modalHeading
      .waitFor({ state: "visible", timeout: firstWaitMs })
      .then(() => /** @type {const} */ (["modal", null]))
      .catch(() => /** @type {const} */ (["none", null]));

    await link.click({ timeout: 15_000 });

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
      await sleep(400);
      if (pg.isClosed()) return null;
      const innerLink = await resolveIceTradeModalPdfLink(pg, viewId, nParam);
      if (innerLink) {
        modalLinkFilename = await readIceTradeLinkSiteFilename(innerLink);
        await innerLink.scrollIntoViewIfNeeded().catch(() => {});
        const innerResp = pg
          .waitForResponse((r) => responseLooksLikeAttachment(r), { timeout: clickTimeout })
          .then((r) => /** @type {const} */ ({ kind: "resp", r }))
          .catch(() => /** @type {const} */ ({ kind: "none" }));
        const innerDl = pg
          .waitForEvent("download", { timeout: clickTimeout })
          .then((d) => /** @type {const} */ ({ kind: "dl", d }))
          .catch(() => /** @type {const} */ ({ kind: "none" }));
        const innerPop = pg
          .waitForEvent("popup", { timeout: clickTimeout })
          .then((p) => /** @type {const} */ ({ kind: "pop", p }))
          .catch(() => /** @type {const} */ ({ kind: "none" }));
        await clickIceTradeModalLinkReliable(innerLink);
        const w2 = await Promise.race([innerResp, innerDl, innerPop]);
        if (w2.kind === "resp" || w2.kind === "dl") {
          winner = w2;
        } else if (w2.kind === "pop") {
          const pop = /** @type {{ kind: "pop"; p: import("playwright").Page }} */ (w2).p;
          try {
            const r2 = await pop
              .waitForResponse((r) => responseLooksLikeAttachment(r), { timeout: clickTimeout })
              .catch(() => null);
            if (r2) winner = { kind: "resp", r: r2 };
          } finally {
            await pop.close().catch(() => {});
          }
        }
      }
    }

    if (!winner) {
      const pop = await pg.waitForEvent("popup", { timeout: 3000 }).catch(() => null);
      if (pop) {
        try {
          const r2 = await pop
            .waitForResponse((r) => responseLooksLikeAttachment(r), { timeout: clickTimeout })
            .catch(() => null);
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
      const domHint = modalLinkFilename ?? tableLinkFilename;
      /** @type {string | null} */
      let readPath = null;
      try {
        readPath = await persistIceTradePlaywrightDownload(winner.d, domHint, viewId);
      } catch {
        readPath = (await winner.d.path().catch(() => null)) ?? null;
      }
      if (readPath) {
        const buf = await readFile(readPath);
        const low = readPath.toLowerCase();
        const ctGuess = low.endsWith(".pdf") ? "application/pdf" : null;
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
 * **LENA_ICETRADE_PLAYWRIGHT_SKIP_DOWNLOAD_PRIME** — по умолчанию отдельный прогрев **выкл**; поставьте **0**, чтобы снова открывать карточку вкладкой перед батчем.
 * **LENA_ICETRADE_PLAYWRIGHT_DOWNLOAD_PRIME_MS** — пауза после открытия карточки при прогреве, мс (по умолчанию 2000); при пропуске прогрева не используется.
 * **LENA_ICETRADE_PLAYWRIGHT_CLICK_SETTLE_MS** — пауза на карточке перед кликом по getFile при обходе через UI, мс (по умолчанию 2500).
 *
 * @param {number} timeoutMs
 * @param {string} [primeIceCardPageUrl] — URL карточки IceTrade для однократного `page.goto` перед скачиваниями
 * @param {(api: {{ requestBinary: (fileUrl: string, iceCardPageUrl: string) => Promise<{ buffer: Buffer, contentType: string | null, contentDisposition: string | null }> }}) => Promise<T>} run
 * @param {{ onStep?: (phase: string) => void | Promise<void>, viewId?: string | null }} [opts] — паузы/лог шагов; **viewId** — подпапка загрузок (иначе из URL карточки)
 * @returns {Promise<T>}
 * @template T
 */
export async function withPlaywrightIceTradeDownloadBatch(timeoutMs, primeIceCardPageUrl, run, opts = {}) {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error(
      "Пакет playwright не установлен. Выполните: npm install playwright && npx playwright install chromium",
    );
  }

  const onStep =
    opts && typeof opts.onStep === "function"
      ? opts.onStep
      : async () => {};

  const optVid = opts && typeof opts.viewId === "string" ? opts.viewId.trim() : "";
  const batchViewId =
    (optVid ? normalizeIceTradeViewId(optVid) ?? optVid : "") ||
    (typeof primeIceCardPageUrl === "string" ? normalizeIceTradeViewId(primeIceCardPageUrl) ?? "" : "");

  await maybeCleanupPlaywrightDownloadsBase();

  const storageRaw = process.env.LENA_ICETRADE_PLAYWRIGHT_STORAGE?.trim();
  /** @type {string | undefined} */
  let storagePath;
  if (storageRaw && existsSync(storageRaw)) storagePath = storageRaw;

  const ua =
    process.env.LENA_ICETRADE_USER_AGENT?.trim() ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  const browser = await playwright.chromium.launch(resolvePlaywrightLaunchOptions());
  await onStep("Chromium запущен (сеанс скачивания).");

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
    applyPlaywrightDownloadsPath(ctxOpts, batchViewId || undefined);

    const context = await browser.newContext(ctxOpts);

    const prime = typeof primeIceCardPageUrl === "string" ? primeIceCardPageUrl.trim() : "";
    const primeMs = Math.max(
      0,
      Number.parseInt(process.env.LENA_ICETRADE_PLAYWRIGHT_DOWNLOAD_PRIME_MS?.trim() ?? "2000", 10) || 2000,
    );
    const skipPrime = iceTradePlaywrightSkipDownloadPrime();
    if (prime && !skipPrime) {
      await onStep(`Прогрев: открываю карточку в отдельной вкладке…\n${prime}`);
      const warm = await context.newPage();
      try {
        await warm.goto(prime, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        if (primeMs > 0) await sleep(primeMs);
      } catch {
        /* прогрев необязателен — дальше всё равно пробуем скачивание */
      } finally {
        await warm.close();
      }
      await onStep("Прогрев завершён (вкладка прогрева закрыта). Далее — запросы к файлам и при необходимости клики на карточке.");
    } else if (prime && skipPrime) {
      await onStep(
        `Отдельная вкладка прогрева карточки отключена (по умолчанию; вкл.: LENA_ICETRADE_PLAYWRIGHT_SKIP_DOWNLOAD_PRIME=0). Далее — запросы к файлам и при необходимости UI: карточка → модалка «Загрузка файла» → файл.\n${prime}`,
      );
    }

    /**
     * @param {string} fileUrl
     * @param {string} iceCardPageUrl
     */
    const requestBinary = async (fileUrl, iceCardPageUrl) => {
      await onStep(`Скачивание / обход getFile:\n${fileUrl}`);
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
 *   LENA_ICETRADE_PLAYWRIGHT_SLOW_MO_MS — замедление UI Playwright (мс), наглядно с HEADED
 *   **LENA_ICETRADE_PLAYWRIGHT_DOWNLOADS_DIR** — корень каталога для загрузок; файлы сеанса — в подпапке **&lt;viewId&gt;** (см. {@link getPlaywrightDownloadsDir})
 *   **LENA_ICETRADE_PLAYWRIGHT_DOWNLOADS_SKIP_DAILY_CLEANUP** — не очищать корень загрузок раз в сутки
 *   LENA_ICETRADE_PLAYWRIGHT_MAX_RESPONSE_BYTES — разбор тел ответов JSON до N байт (по умолчанию 4000000)
 *   LENA_ICETRADE_PLAYWRIGHT_SKIP_DOC_UI_CLICKS=1 — не кликать по вкладкам/ссылкам документов (если блок уже открыт)
 *   LENA_ICETRADE_PLAYWRIGHT_FILE_DOWNLOAD=0 — не качать вложения через Playwright при bootstrap (только Node)
 *   LENA_ICETRADE_PLAYWRIGHT_DOWNLOAD_PRIME_MS — пауза после прогрева карточки перед скачиванием вложений (по умолчанию 2000)
 *   LENA_ICETRADE_PLAYWRIGHT_SKIP_DOWNLOAD_PRIME — по умолчанию прогрев вкладкой **не** делается; **0** = включить прогрев перед батчем
 *
 * @param {string} pageUrl
 * @param {number} timeoutMs
 * @param {{ onStep?: (phase: string) => void | Promise<void> }} [opts]
 * @returns {Promise<{ html: string, via: string, networkFileUrls: string[], warnings?: string[] }>}
 */
export async function fetchPageRendered(pageUrl, timeoutMs, opts = {}) {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error(
      "Пакет playwright не установлен. Выполните: npm install playwright && npx playwright install chromium",
    );
  }

  const onStep =
    opts && typeof opts.onStep === "function"
      ? opts.onStep
      : async () => {};

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

  const renderViewId = normalizeIceTradeViewId(pageUrl) ?? "";
  await maybeCleanupPlaywrightDownloadsBase();

  const browser = await playwright.chromium.launch(resolvePlaywrightLaunchOptions());
  await onStep("Chromium запущен (полный рендер карточки).");

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
    applyPlaywrightDownloadsPath(ctxOpts, renderViewId || undefined);

    const context = await browser.newContext(ctxOpts);
    const page = await context.newPage();
    await onStep(`Открываю карточку:\n${pageUrl}`);

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
    await onStep("Карточка загружена. Ищу блок документов и при необходимости кликаю вкладки.");

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

    await onStep("Пробую дождаться ссылок на вложения в видимой области.");

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
      await onStep(`Пауза settle (${settleMs} мс) перед снимком DOM…`);
      await sleep(settleMs);
    }

    await onStep("Снимаю итоговый HTML со страницы.");
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
