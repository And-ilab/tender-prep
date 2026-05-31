#!/usr/bin/env node
/**
 * Тестовый headless-прогон IceTrade → Playwright batch (без окна, без Enter, удобно в фоне).
 *
 *   cd C:\tender-prep
 *   node scripts/icetrade-headless-smoke.mjs 1336510
 *   node scripts/icetrade-headless-smoke.mjs https://icetrade.by/tenders/all/view/1336510 --max-files 2
 *
 * Фон (пример PowerShell, лог в файл):
 *   Start-Process node -WorkingDirectory (Get-Location) -ArgumentList @(
 *     "scripts/icetrade-headless-smoke.mjs","1336510","--max-files","3"
 *   ) -RedirectStandardOutput "icetrade-smoke.log" -RedirectStandardError "icetrade-smoke.log" -NoNewWindow
 *
 * Вывод: JSON в stdout в конце; прогресс — в stderr.
 *
 * Google Drive (как `tenders icetrade-push-downloads`): если в .env задан **LENA_DRIVE_ROOT** (или LENA_ICETRADE_DRIVE_ROOT)
 * и **GOOGLE_DRIVE_CREDENTIALS** / OAuth — после прогона содержимое **&lt;LENA_ICETRADE_PLAYWRIGHT_DOWNLOADS_DIR&gt;/&lt;viewId&gt;/**
 * уходит в **_lena/tenders/&lt;год&gt;/&lt;viewId&gt;/inputs/** (дерево создаётся через API; год — LENA_DEFAULT_TENDER_YEAR или текущий;
 * путь без года: флаг --drive-flat).
 *
 * Переменные: diagnose/bootstrap + LENA_DRIVE_ROOT, GOOGLE_DRIVE_*.
 *
 * Флаги:
 *   --max-files N    сколько URL качать (по умолчанию 4)
 *   --full           после батча ещё fetchPageRendered + доп. URL (медленнее)
 *   --skip-node      не делать шаг Node-fetch по каждому файлу (только Playwright)
 *   --no-drive       не заливать на Drive даже при LENA_DRIVE_ROOT
 *   --drive-flat     путь тендера на Drive без года (_lena/tenders/&lt;id&gt;/inputs/)
 *   --drive-year ГГГГ явный год в пути
 *   --verbose, -v    пошаговый лог в stderr (тайминги, внутренние шаги Playwright; без Enter)
 *   или LENA_ICETRADE_SMOKE_VERBOSE=1
 *
 * Демо-лог без точек останова: npm run icetrade:smoke-demo-log -- 1336510
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveDriveId } from "../src/drive/ids.js";
import {
  fetchIceTradeCardHtml,
  downloadIceTradeBinary,
  validateAttachmentBuffer,
} from "../src/icetrade/fetchPage.js";
import {
  withPlaywrightIceTradeDownloadBatch,
  fetchPageRendered,
  getPlaywrightDownloadsDir,
} from "../src/icetrade/fetchPageRendered.js";
import { pushLocalFilesToTenderInputs } from "../src/icetrade/pushLocalDownloadsToInputs.js";
import { normalizeIceTradeViewId } from "../src/icetrade/viewIds.js";
import { extractAttachmentCandidates, isIceTradeLoginWallHtml } from "../src/icetrade/scrapeAttachments.js";

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

/** В этом скрипте всегда фон/headless: не берём HEADED/SLOW_MO из .env. */
process.env.LENA_ICETRADE_PLAYWRIGHT_HEADED = "0";
process.env.LENA_ICETRADE_PLAYWRIGHT_SLOW_MO_MS = "0";

const VIEW_PAGE = (/** @type {string} */ id) => `https://icetrade.by/tenders/all/view/${id}`;

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

function fileHeadersForUrl(fileUrl, cardUrl) {
  return {
    ...icetradeFetchHeaders(),
    Accept: "*/*",
    Referer: downloadRefererForFileUrl(fileUrl, cardUrl),
  };
}

/** @param {string} fileUrl @param {string | undefined} linkText */
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

function timeoutMs() {
  const t =
    Number.parseInt(process.env.LENA_ICETRADE_FETCH_TIMEOUT_MS?.trim() ?? "120000", 10) || 120_000;
  return Math.max(10_000, t);
}

/** Корень Лены на Drive (тот же, что у бота / `tenders icetrade-bootstrap`). */
function lenaDriveRootFromEnv() {
  return (
    process.env.LENA_DRIVE_ROOT?.trim() ||
    process.env.LENA_ICETRADE_DRIVE_ROOT?.trim() ||
    ""
  );
}

function parseArgs(argv) {
  /** @type {string[]} */
  const positionals = [];
  let maxFiles = 4;
  let full = false;
  let skipNode = false;
  let noDrive = false;
  let driveFlat = false;
  /** @type {string | null} */
  let driveYear = null;
  let verbose = false;
  let help = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (a === "--verbose" || a === "-v") {
      verbose = true;
      continue;
    }
    if (a === "--full") {
      full = true;
      continue;
    }
    if (a === "--skip-node") {
      skipNode = true;
      continue;
    }
    if (a === "--no-drive") {
      noDrive = true;
      continue;
    }
    if (a === "--drive-flat") {
      driveFlat = true;
      continue;
    }
    if (a === "--drive-year") {
      const yy = argv[++i];
      driveYear = yy && /^\d{4}$/.test(yy) ? yy : null;
      continue;
    }
    if (a === "--max-files") {
      const n = Number.parseInt(argv[++i] ?? "", 10);
      if (Number.isFinite(n) && n >= 0) maxFiles = n;
      continue;
    }
    if (a.startsWith("-")) {
      console.error(`Неизвестный флаг: ${a}`);
      help = true;
      break;
    }
    positionals.push(a);
  }
  return { positionals, maxFiles, full, skipNode, noDrive, driveFlat, driveYear, verbose, help };
}

const { positionals, maxFiles, full, skipNode, noDrive, driveFlat, driveYear, verbose: verboseFlag, help } =
  parseArgs(process.argv);

const verbose =
  verboseFlag ||
  process.env.LENA_ICETRADE_SMOKE_VERBOSE?.trim() === "1" ||
  /^(true|yes|on)$/i.test(process.env.LENA_ICETRADE_SMOKE_VERBOSE?.trim() ?? "");

if (help || positionals.length < 1) {
  console.error(`Использование:
  node scripts/icetrade-headless-smoke.mjs <viewId|URL> [опции]

Drive: задайте LENA_DRIVE_ROOT (или LENA_ICETRADE_DRIVE_ROOT) + учётные данные Google из docs/GOOGLE_DRIVE.md
Опции: --max-files N  --full  --skip-node  --no-drive  --drive-flat  --drive-year ГГГГ  -v/--verbose`);
  process.exit(help ? 0 : 1);
}

const raw = positionals[0].trim();
let cardUrl;
/** @type {string} */
let viewLabel;
if (/^https?:\/\//i.test(raw)) {
  cardUrl = raw.split("#")[0].split("?")[0];
  const id = normalizeIceTradeViewId(raw);
  if (!id) {
    console.error("Не удалось извлечь view id из URL.");
    process.exit(1);
  }
  viewLabel = id;
} else {
  const id = normalizeIceTradeViewId(raw);
  if (!id) {
    console.error("Укажите номер закупки или URL карточки.");
    process.exit(1);
  }
  viewLabel = id;
  cardUrl = VIEW_PAGE(id);
}

const tmo = timeoutMs();
const downloadsDir = getPlaywrightDownloadsDir(viewLabel);

let logSeq = 0;
let logPrevMs = Date.now();
function log(/** @type {string} */ msg) {
  const now = Date.now();
  const delta = now - logPrevMs;
  logPrevMs = now;
  const clock = new Date().toISOString().slice(11, 23);
  if (verbose) {
    logSeq += 1;
    console.error(`\n━━ ${String(logSeq).padStart(2, "0")} · ${clock} · +${delta}ms ━━\n${msg}`);
  } else {
    console.error(`[icetrade-smoke ${clock.slice(0, 8)}] ${msg}`);
  }
}

function logSub(/** @type {string} */ msg) {
  if (!verbose) return;
  for (const line of msg.split("\n")) {
    console.error(`    │ ${line}`);
  }
}

const playwrightLogOpts = {
  viewId: viewLabel,
  ...(verbose
    ? {
        onStep: async (/** @type {string} */ phase) => {
          logSub(phase);
        },
      }
    : {}),
};

if (verbose) {
  console.error("\n════════ icetrade-headless-smoke · подробный лог (без точек останова) ════════");
}
log(`Старт view=${viewLabel} timeout=${tmo}ms downloadsDir=${downloadsDir}`);

/** @type {{ url: string, linkText?: string }[]} */
let fileTargets = [];

let htmlNode = "";
let nodeVia = "";
try {
  log("Карточка: загрузка HTML (Node)…");
  const r = await fetchIceTradeCardHtml(cardUrl, icetradeFetchHeaders(), tmo);
  htmlNode = r.html;
  nodeVia = r.via;
  if (verbose) logSub(`via=${nodeVia}, bytes=${htmlNode.length}`);
} catch (e) {
  console.error(
    JSON.stringify({
      ok: false,
      phase: "card_html",
      error: e instanceof Error ? e.message : String(e),
      cardUrl,
    }),
  );
  process.exit(1);
}

if (htmlNode) {
  const cands = extractAttachmentCandidates(htmlNode, cardUrl);
  fileTargets = cands.slice(0, maxFiles).map((c) => ({ url: c.url, linkText: c.linkText }));
  log(`HTML: ${htmlNode.length} байт, кандидатов к проверке: ${fileTargets.length} (из ${cands.length})`);
} else {
  log("HTML карточки пуст");
}

/** @type {{ ok: boolean, results: object[], phase?: string }[]} */
const phases = [];

/** @type {object[]} */
const nodeResults = [];
if (!skipNode && fileTargets.length > 0) {
  log(`Node-fetch: ${fileTargets.length} файлов…`);
  for (let i = 0; i < fileTargets.length; i++) {
    const { url: fileUrl, linkText } = fileTargets[i];
    const nameForVal = validationFileName(fileUrl, linkText);
    if (verbose) logSub(`[${i + 1}/${fileTargets.length}] ${nameForVal}\n${fileUrl}`);
    try {
      const h = fileHeadersForUrl(fileUrl, cardUrl);
      const { buffer, contentType, via } = await downloadIceTradeBinary(fileUrl, h, tmo);
      const v = validateAttachmentBuffer(buffer, nameForVal, contentType);
      if (verbose)
        logSub(`получено ${buffer.length} B, via=${via}, validate=${v.ok ? "ok" : v.reason}`);
      nodeResults.push({
        i: i + 1,
        url: fileUrl,
        via,
        bytes: buffer.length,
        validateOk: v.ok,
        validateReason: v.ok ? undefined : v.reason,
      });
    } catch (e) {
      nodeResults.push({
        i: i + 1,
        url: fileUrl,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  log("Node-fetch: готово");
  phases.push({ ok: true, phase: "node_fetch", results: nodeResults });
}

/** @type {object[]} */
const pwResults = [];

if (fileTargets.length > 0) {
  try {
    log(`Playwright: сеанс Chromium (headless), файлов ${fileTargets.length}…`);
    await withPlaywrightIceTradeDownloadBatch(
      tmo,
      cardUrl,
      async ({ requestBinary }) => {
        for (let i = 0; i < fileTargets.length; i++) {
          const { url: fileUrl, linkText } = fileTargets[i];
          const nameForVal = validationFileName(fileUrl, linkText);
          log(
            verbose
              ? `Файл ${i + 1}/${fileTargets.length}: ${nameForVal}`
              : `Playwright ${i + 1}/${fileTargets.length} …`,
          );
          if (verbose) logSub(fileUrl);
          try {
            const { buffer, contentType } = await requestBinary(fileUrl, cardUrl);
            const v = validateAttachmentBuffer(buffer, nameForVal, contentType);
            if (verbose)
              logSub(`validate=${v.ok ? "ok" : v.reason}, bytes=${buffer.length}, ct=${contentType ?? "?"}`);
            pwResults.push({
              i: i + 1,
              url: fileUrl,
              bytes: buffer.length,
              validateOk: v.ok,
              validateReason: v.ok ? undefined : v.reason,
            });
          } catch (e) {
            pwResults.push({
              i: i + 1,
              url: fileUrl,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      },
      playwrightLogOpts,
    );
    log("Playwright: сеанс завершён");
    phases.push({ ok: true, phase: "playwright_batch", results: pwResults });
  } catch (e) {
    console.error(
      JSON.stringify({
        ok: false,
        phase: "playwright_batch",
        error: e instanceof Error ? e.message : String(e),
        cardUrl,
      }),
    );
    process.exit(1);
  }
}

if (full && htmlNode) {
  try {
    log("Полный рендер страницы (fetchPageRendered)…");
    const r = await fetchPageRendered(cardUrl, tmo, playwrightLogOpts);
    const cands2 = extractAttachmentCandidates(r.html, cardUrl);
    const known = new Set(fileTargets.map((t) => t.url));
    const extra = cands2.filter((c) => !known.has(c.url)).slice(0, Math.max(0, maxFiles - fileTargets.length));
    /** @type {object[]} */
    const fullExtra = [];
    if (extra.length > 0) {
      log(`Доп. URL после рендера: ${extra.length}`);
      await withPlaywrightIceTradeDownloadBatch(
        tmo,
        cardUrl,
        async ({ requestBinary }) => {
          let ei = 0;
          for (const c of extra) {
            ei += 1;
            const nameForVal = validationFileName(c.url, c.linkText);
            if (verbose) log(`Доп. файл ${ei}/${extra.length}: ${nameForVal}`);
            if (verbose) logSub(c.url);
            try {
              const { buffer, contentType } = await requestBinary(c.url, cardUrl);
              const v = validateAttachmentBuffer(buffer, nameForVal, contentType);
              if (verbose)
                logSub(`validate=${v.ok ? "ok" : v.reason}, bytes=${buffer.length}`);
              fullExtra.push({
                url: c.url,
                bytes: buffer.length,
                validateOk: v.ok,
                validateReason: v.ok ? undefined : v.reason,
              });
            } catch (e) {
              fullExtra.push({
                url: c.url,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
        },
        playwrightLogOpts,
      );
    }
    phases.push({
      ok: true,
      phase: "fetchPageRendered_extra",
      networkFileUrls: r.networkFileUrls.length,
      extraTried: extra.length,
      results: fullExtra,
    });
  } catch (e) {
    phases.push({
      ok: false,
      phase: "fetchPageRendered",
      error: e instanceof Error ? e.message : String(e),
    });
  }
  log("Секция --full завершена");
}

if (verbose) {
  console.error("\n════════ итог — JSON на stdout ниже ════════\n");
}

const loginWall = htmlNode ? isIceTradeLoginWallHtml(htmlNode) : false;

const noCandidates = fileTargets.length === 0;
const pwComplete = !noCandidates && pwResults.length === fileTargets.length;
const pwAllOk =
  pwComplete && pwResults.every((r) => !("error" in r && r.error) && r.validateOk === true);

const summary = {
  ok: !noCandidates && pwAllOk,
  viewId: viewLabel,
  cardUrl,
  headless: true,
  downloadsDir,
  cardHtml: {
    length: htmlNode.length,
    via: nodeVia,
    loginWallHeuristic: loginWall,
    candidateCount: fileTargets.length,
    candidatesEmpty: noCandidates,
    maxFiles,
  },
  phases,
};

let drivePush = /** @type {Awaited<ReturnType<typeof pushLocalFilesToTenderInputs>> | { ok: false, error: string } | null} */ (
  null
);

const driveRootEnv = !noDrive ? lenaDriveRootFromEnv() : "";
if (driveRootEnv) {
  log(`Google Drive: ${driveRootEnv.slice(0, 48)}… → inputs (${viewLabel})`);
  try {
    const rootId = resolveDriveId(driveRootEnv);
    drivePush = await pushLocalFilesToTenderInputs(rootId, viewLabel, downloadsDir, {
      flat: driveFlat,
      year: driveYear ?? undefined,
    });
    log(
      `Drive: загружено ${drivePush.uploaded.length}, пропущено (уже в inputs) ${drivePush.skipped.length}, ошибок ${drivePush.errors.length}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    drivePush = { ok: false, error: msg };
    log(`Drive: сбой — ${msg}`);
  }
} else if (!noDrive) {
  log("Google Drive: пропуск (нет LENA_DRIVE_ROOT / LENA_ICETRADE_DRIVE_ROOT)");
} else {
  log("Google Drive: отключено (--no-drive)");
}

summary.drivePush = drivePush;

let driveOk = true;
if (drivePush && "error" in drivePush && drivePush.error) driveOk = false;
else if (drivePush && "errors" in drivePush && drivePush.errors.length > 0) driveOk = false;

log(`Готово: smokeOk=${summary.ok} driveOk=${driveOk} (JSON → stdout)`);
console.log(JSON.stringify(summary, null, 2));

process.exitCode = summary.ok && driveOk ? 0 : 1;
