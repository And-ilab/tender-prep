#!/usr/bin/env node
/**
 * Пошаговая диагностика скачивания вложений IceTrade (и goszakupki get-file).
 * Сравнивает Node-fetch, Playwright APIRequest после прогрева карточки и опционально полный рендер страницы.
 *
 * Требуется: npm install playwright && npx playwright install chromium (для шагов Playwright).
 *
 * Переменные: см. `.env` в корне репозитория (скрипт подгружает его, как бот) **или** задайте в PowerShell через $env:... перед запуском.
 *
 * Примеры:
 *   node scripts/icetrade-download-diagnose.mjs 1336510
 *   node scripts/icetrade-download-diagnose.mjs "https://icetrade.by/tenders/all/view/1336510" --max-files 2
 *   node scripts/icetrade-download-diagnose.mjs 1336510 --quick --url "<вставьте URL файла из браузера>"
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeIceTradeViewId } from "../src/icetrade/viewIds.js";
import {
  fetchIceTradeCardHtml,
  downloadIceTradeBinary,
  validateAttachmentBuffer,
} from "../src/icetrade/fetchPage.js";
import {
  withPlaywrightIceTradeDownloadBatch,
  fetchPageRendered,
} from "../src/icetrade/fetchPageRendered.js";
import { extractAttachmentCandidates, isIceTradeLoginWallHtml } from "../src/icetrade/scrapeAttachments.js";

/**
 * Сводка по `storageState` Playwright (без вывода секретов).
 * @returns {{ ok: boolean, total: number, icetradeDomain: number, icetradeNames: string[], err?: string }}
 */
function summarizePlaywrightStorage() {
  const p = process.env.LENA_ICETRADE_PLAYWRIGHT_STORAGE?.trim();
  if (!p) return { ok: false, total: 0, icetradeDomain: 0, icetradeNames: [], err: "не задан путь" };
  if (!existsSync(p)) return { ok: false, total: 0, icetradeDomain: 0, icetradeNames: [], err: "файл не найден" };
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    const cookies = Array.isArray(j.cookies) ? j.cookies : [];
    const iceCookies = cookies.filter((c) => /icetrade\.by/i.test(String(c.domain || "")));
    const icetradeNames = [...new Set(iceCookies.map((c) => String(c.name || "?")))].sort();
    return {
      ok: true,
      total: cookies.length,
      icetradeDomain: iceCookies.length,
      icetradeNames,
    };
  } catch (e) {
    return {
      ok: false,
      total: 0,
      icetradeDomain: 0,
      icetradeNames: [],
      err: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Подгружает `C:\\tender-prep\\.env` при запуске из корня (значения LENA_* из файла перебивают пустые переменные процесса).
 */
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

/** @param {string} fileUrl @param {string} iceCardPageUrl */
function downloadRefererForFileUrl(fileUrl, iceCardPageUrl) {
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

function icetradeFetchHeaders() {
  const ua =
    process.env.LENA_ICETRADE_USER_AGENT?.trim() ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const h = {
    "User-Agent": ua,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.4",
    Referer: "https://icetrade.by/",
  };
  const cookie = process.env.LENA_ICETRADE_COOKIE?.trim();
  if (cookie) h.Cookie = cookie;
  return h;
}

function fileHeadersForUrl(fileUrl, cardUrl) {
  return {
    ...icetradeFetchHeaders(),
    Accept: "*/*",
    Referer: downloadRefererForFileUrl(fileUrl, cardUrl),
  };
}

/** Имя для validateAttachmentBuffer: при getFile в URL нет .pdf — берём из текста ссылки. */
function validationFileName(fileUrl, linkText) {
  const t = linkText?.trim();
  if (t && /\.(pdf|docx?|zip|rar|7z|xlsx?|csv|txt|pptx?)$/i.test(t)) return t;
  try {
    const path = new URL(fileUrl).pathname;
    const seg = path.split("/").filter(Boolean).pop() || "file.bin";
    if (/\.(pdf|docx?|zip|rar|7z|xlsx?|csv|txt|pptx?)$/i.test(seg)) return seg;
  } catch {
    /* ignore */
  }
  return fileUrl.split("/").pop()?.split("?")[0] || "file.bin";
}

function parseArgs(argv) {
  /** @type {string[]} */
  const positionals = [];
  let maxFiles = 4;
  let quick = false;
  let skipNode = false;
  let skipPwBatch = false;
  /** @type {string | null} */
  let onlyUrl = null;
  let help = false;

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (a === "--quick") {
      quick = true;
      continue;
    }
    if (a === "--skip-node") {
      skipNode = true;
      continue;
    }
    if (a === "--skip-playwright-batch") {
      skipPwBatch = true;
      continue;
    }
    if (a === "--max-files") {
      const n = Number.parseInt(argv[++i] ?? "", 10);
      if (Number.isFinite(n) && n >= 0) maxFiles = n;
      continue;
    }
    if (a === "--url") {
      onlyUrl = argv[++i] ?? null;
      continue;
    }
    if (a.startsWith("-")) {
      console.error(`Неизвестный флаг: ${a}`);
      help = true;
      break;
    }
    positionals.push(a);
  }

  return { positionals, maxFiles, quick, skipNode, skipPwBatch, onlyUrl, help };
}

function timeoutMs() {
  const t =
    Number.parseInt(process.env.LENA_ICETRADE_FETCH_TIMEOUT_MS?.trim() ?? "120000", 10) || 120_000;
  return Math.max(10_000, t);
}

/** @param {Buffer} buf @param {string | null} contentType @param {string} label */
function printBufferDiagnosis(buf, contentType, label) {
  const n = buf.length;
  const ct = contentType || "(нет)";
  const head = buf.subarray(0, Math.min(64, n));
  const hex = [...head].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const ascii = head.toString("latin1").replace(/[^\x20-\x7e]/g, ".");
  const sig5 = buf.subarray(0, 5).toString("latin1");
  console.log(`    ${label}: bytes=${n} Content-Type=${ct}`);
  console.log(`    первые байты (hex): ${hex || "(пусто)"}`);
  console.log(`    первые байты (latin1): ${ascii}`);
  if (sig5.startsWith("%PDF")) console.log("    сигнатура: PDF");
  else if (ascii.trimStart().startsWith("<") || sig5.startsWith("<"))
    console.log("    сигнатура: похоже на HTML/XML");

  if (n > 32 && (ct.includes("html") || ascii.includes("<"))) {
    const snippet = buf.subarray(0, Math.min(12_000, n)).toString("utf8");
    const tMatch = /<title[^>]*>\s*([^<]+?)\s*</i.exec(snippet);
    if (tMatch) console.log(`    HTML title: ${tMatch[1].trim().slice(0, 120)}`);
    if (isIceTradeLoginWallHtml(snippet)) {
      console.log(
        "    HTML: распознана типичная форма входа IceTrade (эвристика). Для публичных карточек в браузере это часто не «надо логиниться», а ответ площадки на автоматический GET — см. User-Agent, прогрев карточки, таймауты.",
      );
    } else if (/name\s*=\s*["']llogin["']/i.test(snippet)) {
      console.log(
        "    HTML: есть llogin — похоже на шаблон главной/входа в ответе, не обязательно требование ЛК.",
      );
    }
    const getFile = [
      ...snippet.matchAll(/https?:\/\/(?:www\.)?goszakupki\.by\/auction\/get-file\/\d+[^\s"'<>]*/gi),
    ].map((m) => m[0]);
    const uniq = [...new Set(getFile)];
    if (uniq.length) console.log(`    в теле (HTML): найдено ссылок get-file: ${uniq.length} (показ до 5):`);
    for (const u of uniq.slice(0, 5)) console.log(`      ${u}`);
  }
}

function printEnvSummary() {
  const storage = process.env.LENA_ICETRADE_PLAYWRIGHT_STORAGE?.trim();
  const cookie = process.env.LENA_ICETRADE_COOKIE?.trim();
  console.log("\n=== Контекст окружения ===");
  console.log(`  LENA_ICETRADE_PLAYWRIGHT_STORAGE: ${storage ? "(задано, длина пути " + storage.length + ")" : "(нет)"}`);
  if (storage) {
    const st = summarizePlaywrightStorage();
    if (st.ok) {
      console.log(
        `  └ storageState: куки ${st.total} шт., для домена icetrade.by — ${st.icetradeDomain}`,
      );
      if (st.total === 0) {
        console.log(
          "  └ ВНИМАНИЕ: cookies[] пуст в JSON — пересохраните playwright-auth с карточки (Enter после загрузки страницы).",
        );
      } else if (st.icetradeDomain === 0) {
        console.log(
          "  └ ВНИМАНИЕ: нет кук с доменом icetrade.by — пересохраните JSON с сайта icetrade.by.",
        );
      } else if (st.icetradeNames.length) {
        console.log(`  └ куки icetrade.by (только имена): ${st.icetradeNames.join(", ")}`);
        if (st.total <= 5) {
          console.log(
            "  └ подсказка: мало записей в storage — для сравнения снимите Cookie из обычного браузера (LENA_ICETRADE_COOKIE); публичные файлы ЛК не требуют.",
          );
        }
      }
    } else {
      console.log(`  └ storageState: не удалось прочитать — ${st.err}`);
    }
  }
  console.log(` LENA_ICETRADE_COOKIE: ${cookie ? "(задано, " + cookie.length + " симв.)" : "(нет)"}`);
  console.log(`  FETCH_TIMEOUT_MS: ${timeoutMs()}`);
  console.log(
    `  LENA_ICETRADE_PLAYWRIGHT_HEADED: ${process.env.LENA_ICETRADE_PLAYWRIGHT_HEADED?.trim() || "(unset → headless)"}`,
  );
  console.log(`  LENA_ICETRADE_FETCH_BACKEND: ${process.env.LENA_ICETRADE_FETCH_BACKEND?.trim() || "auto"}`);
}

/**
 * @param {string} step
 * @param {string} title
 */
function heading(step, title) {
  console.log(`\n--- ${step}: ${title} ---`);
}

const { positionals, maxFiles, quick, skipNode, skipPwBatch, onlyUrl, help } = parseArgs(process.argv);

if (help || positionals.length < 1) {
  console.log(`Использование:
  node scripts/icetrade-download-diagnose.mjs <viewId|URL> [опции]

Пример:
  node scripts/icetrade-download-diagnose.mjs https://icetrade.by/tenders/all/view/1336510

Опции:
  --max-files N            сколько URL из HTML проверить (по умолчанию 4)
  --url URL                проверить только этот URL файла (карточка всё равно нужна для Referer/прогрева)
  --quick                  не вызывать fetchPageRendered (полный Chromium + клики по документам)
  --skip-node              не скачивать через Node (downloadIceTradeBinary)
  --skip-playwright-batch  не вызывать withPlaywrightIceTradeDownloadBatch

Задайте в файле C:\\tender-prep\\.env (см. examples\\env.telegram.example) **или** в PowerShell перед node:

  $env:LENA_ICETRADE_PLAYWRIGHT_STORAGE = 'C:\\secrets\\icetrade-storage.json'

Запускайте из корня: cd C:\\tender-prep`);
  process.exit(help ? 0 : 1);
}

const raw = positionals[0].trim();
let cardUrl;
if (/^https?:\/\//i.test(raw)) {
  cardUrl = raw.split("#")[0].split("?")[0];
  const id = normalizeIceTradeViewId(raw);
  if (!id) {
    console.error("Не удалось извлечь номер закупки из URL — укажите полный URL карточки icetrade.by/view/<id>");
    process.exit(1);
  }
} else {
  const id = normalizeIceTradeViewId(raw);
  if (!id) {
    console.error("Укажите номер закупки (цифры) или полный URL карточки.");
    process.exit(1);
  }
  cardUrl = VIEW_PAGE(id);
}

printEnvSummary();
heading("1", `Карточка (Node): ${cardUrl}`);

let htmlNode = "";
let nodeVia = "";
try {
  const r = await fetchIceTradeCardHtml(cardUrl, icetradeFetchHeaders(), timeoutMs());
  htmlNode = r.html;
  nodeVia = r.via;
  console.log(`  HTML получен через: ${nodeVia}, длина ${htmlNode.length}`);
  if (isIceTradeLoginWallHtml(htmlNode)) {
    console.log(
      "  ПРИМЕЧАНИЕ: HTML похож на форму входа (эвристика); на публичных карточках в браузере без ЛК может быть иначе — проверьте Playwright/заголовки.",
    );
  }
} catch (e) {
  console.error(`  Ошибка: ${e instanceof Error ? e.message : String(e)}`);
}

/** @type {{ url: string, linkText?: string }[]} */
let fileTargets = [];
if (onlyUrl?.trim()) {
  fileTargets = [{ url: onlyUrl.trim() }];
  console.log(`  Режим --url: одна цель`);
} else if (htmlNode) {
  const cands = extractAttachmentCandidates(htmlNode, cardUrl);
  console.log(`  Кандидаты из Node HTML: ${cands.length} шт.`);
  cands.slice(0, 8).forEach((c, i) => {
    console.log(`    [${i}] ${c.linkText ? JSON.stringify(c.linkText) : "—"} → ${c.url}`);
  });
  fileTargets = cands.slice(0, maxFiles).map((c) => ({ url: c.url, linkText: c.linkText }));
}

if (!fileTargets.length) {
  console.log(
    "  Нет URL для проверки файлов. Укажите --url либо дождитесь шага 4 (полный рендер Playwright).",
  );
}

for (let i = 0; i < fileTargets.length; i++) {
  const { url: fileUrl, linkText } = fileTargets[i];
  heading(`2.${i + 1}`, `Файл (Node): ${fileUrl}`);
  if (skipNode) {
    console.log("  пропуск (--skip-node)");
    continue;
  }
  try {
    const h = fileHeadersForUrl(fileUrl, cardUrl);
    const { buffer, contentType, via } = await downloadIceTradeBinary(fileUrl, h, timeoutMs());
    printBufferDiagnosis(buffer, contentType, `Node (${via})`);
    const nameForVal = validationFileName(fileUrl, linkText);
    const v = validateAttachmentBuffer(buffer, nameForVal, contentType);
    console.log(`    validateAttachmentBuffer (${nameForVal}): ${v.ok ? "ok" : "FAIL — " + v.reason}`);
  } catch (e) {
    console.error(`  Ошибка: ${e instanceof Error ? e.message : String(e)}`);
  }
}

if (!skipPwBatch) {
  heading("3", "Playwright: прогрев карточки + context.request.get (как в bootstrap)");
  try {
    await withPlaywrightIceTradeDownloadBatch(timeoutMs(), cardUrl, async ({ requestBinary }) => {
      for (let i = 0; i < fileTargets.length; i++) {
        const { url: fileUrl, linkText } = fileTargets[i];
        console.log(`\n  [${i + 1}/${fileTargets.length}] ${fileUrl}`);
        try {
          const { buffer, contentType } = await requestBinary(fileUrl, cardUrl);
          printBufferDiagnosis(buffer, contentType, "Playwright request + fallback goto");
          const nameForVal = validationFileName(fileUrl, linkText);
          const v = validateAttachmentBuffer(buffer, nameForVal, contentType);
          console.log(`    validateAttachmentBuffer (${nameForVal}): ${v.ok ? "ok" : "FAIL — " + v.reason}`);
        } catch (e) {
          console.error(`  Ошибка: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    });
  } catch (e) {
    console.error(`  Ошибка сессии Playwright: ${e instanceof Error ? e.message : String(e)}`);
  }
} else {
  heading("3", "Playwright batch пропущен (--skip-playwright-batch)");
}

if (!quick) {
  heading("4", "Playwright: fetchPageRendered (клики по блоку документов, settle, сеть JSON)");
  try {
    const r = await fetchPageRendered(cardUrl, timeoutMs());
    if (r.warnings?.length) for (const w of r.warnings) console.log(`  warning: ${w}`);
    console.log(`  HTML длина: ${r.html.length}, networkFileUrls: ${r.networkFileUrls.length}`);
    if (r.networkFileUrls.length) {
      console.log("  из JSON ответов (первые 8):");
      for (const u of r.networkFileUrls.slice(0, 8)) console.log(`    ${u}`);
    }
    if (isIceTradeLoginWallHtml(r.html)) {
      console.log(
        "  ПРИМЕЧАНИЕ: эвристика «форма входа» на полном рендере — при публичной карточке смотрите на список кандидатов и сеть JSON выше.",
      );
    }
    const cands = extractAttachmentCandidates(r.html, cardUrl);
    console.log(`  Кандидаты после рендера: ${cands.length} шт.`);
    cands.slice(0, 8).forEach((c, i) => {
      console.log(`    [${i}] ${c.linkText ? JSON.stringify(c.linkText) : "—"} → ${c.url}`);
    });

    const knownUrls = new Set(fileTargets.map((t) => t.url));
    const extra = cands.filter((c) => !knownUrls.has(c.url)).slice(0, Math.max(0, maxFiles - fileTargets.length));
    if (extra.length && !onlyUrl) {
      console.log("\n  Доп. URL только из шага 4 (не были в шаге 2), повторная проверка Playwright request:");
      await withPlaywrightIceTradeDownloadBatch(timeoutMs(), cardUrl, async ({ requestBinary }) => {
        for (const c of extra) {
          const fileUrl = c.url;
          console.log(`\n    ${fileUrl}`);
          try {
            const { buffer, contentType } = await requestBinary(fileUrl, cardUrl);
            printBufferDiagnosis(buffer, contentType, "Playwright");
            const nameForVal = validationFileName(fileUrl, c.linkText);
            const v = validateAttachmentBuffer(buffer, nameForVal, contentType);
            console.log(`    validateAttachmentBuffer (${nameForVal}): ${v.ok ? "ok" : "FAIL — " + v.reason}`);
          } catch (e) {
            console.error(`    Ошибка: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      });
    }
  } catch (e) {
    console.error(`  Ошибка: ${e instanceof Error ? e.message : String(e)}`);
  }
} else {
  heading("4", "fetchPageRendered пропущен (--quick)");
}

console.log("\n=== Готово ===\n");
