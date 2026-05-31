import { mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertCredentialsFile } from "../drive/config.js";
import { getMetadata, listChildren, trashDriveFile, uploadFile } from "../drive/ops.js";
import { ensureTenderTree } from "../drive/workspace.js";
import { extractIceTradeViewIds, normalizeIceTradeViewId } from "./viewIds.js";
import { fetchIceTradeCardHtml, downloadIceTradeBinary, downloadIceTradeBatchViaPowerShellSession, defaultIceTradeAttachmentFileName, validateAttachmentBuffer } from "./fetchPage.js";
import {
  fetchIceTradeCardHtmlPlaywright,
  iceTradePlaywrightEnabled,
  playwrightChromiumLikelyInstalled,
  withPlaywrightIceTradeDownloadBatch,
} from "./fetchPageRendered.js";
import { iceTradePythonFetchMode, runPythonIceTradeFetch } from "./bootstrapPythonSidecar.js";
import { extractAttachmentCandidates, isIceTradeLoginWallHtml, isIceTradePlatformHelpAttachment } from "./scrapeAttachments.js";
import { buildIceTradeImportSnapshot, importSnapshotToJson } from "./importPageMeta.js";

const VIEW_PAGE = (/** @type {string} */ id) => `https://icetrade.by/tenders/all/view/${id}`;

// #region agent log
/** @param {string} location @param {string} message @param {Record<string, unknown>} data @param {string} hypothesisId */
function _dbgAgentLog(location, message, data, hypothesisId) {
  const payload = {
    sessionId: "65c8b6",
    location,
    message,
    data,
    timestamp: Date.now(),
    hypothesisId,
  };
  fetch("http://127.0.0.1:7273/ingest/0fbf9c34-aa58-4c41-8b66-36b66355e6e0", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "65c8b6" },
    body: JSON.stringify(payload),
  }).catch(() => {});
  appendFile(join(process.cwd(), "debug-65c8b6.log"), `${JSON.stringify(payload)}\n`).catch(() => {});
}
// #endregion

/**
 * Комплект на карточке IceTrade может вести и на файлы самой ЭТП (icetrade.by), и на выдачу с **goszakupki.by** (напр. /auction/get-file/…).
 * Referer для GET файла лучше совпадать с хостом назначения, иначе часть ответов режет антибот.
 * @param {string} fileUrl
 * @param {string} iceCardPageUrl
 */
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

/** Более «браузерный» UA; иначе площадка или CDN могут рвать соединение для необычного клиента. Переопределение: LENA_ICETRADE_USER_AGENT. */
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

function safeBasename(name) {
  const s = String(name)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ");
  return (s.slice(0, 180) || "file").trim();
}

function driveFileSizeBytes(f) {
  const s = /** @type {{ size?: string }} */ (f).size;
  if (s === undefined || s === null) return 0;
  const n = Number.parseInt(String(s), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * PDF на Drive меньше порога — типично «заглушка» после неудачной загрузки; разрешаем замену при следующем bootstrap.
 * Порог: **LENA_ICETRADE_REPLACE_PDF_IF_BYTES_BELOW** (по умолчанию 96 KiB).
 * @param {{ name?: string, size?: string, id?: string }} fileMeta
 * @param {string} fileName
 */
function shouldReplaceSmallPdfOnDrive(fileMeta, fileName) {
  const low = fileName.toLowerCase();
  if (!low.endsWith(".pdf")) return false;
  const threshold =
    Number.parseInt(process.env.LENA_ICETRADE_REPLACE_PDF_IF_BYTES_BELOW?.trim() ?? "98304", 10) || 98304;
  const sz = driveFileSizeBytes(fileMeta);
  return sz > 0 && sz < threshold;
}

function guessFileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const base = u.pathname.split("/").pop() || "download";
    return safeBasename(decodeURIComponent(base.split("?")[0]));
  } catch {
    return "download.bin";
  }
}

/**
 * Ожидаемое имя в inputs до HTTP (без Content-Disposition) — для пропуска повторного скачивания.
 * @param {string} fileUrl
 * @param {string | undefined} linkText
 */
function predictInputFileNameBeforeDownload(fileUrl, linkText) {
  return resolveDownloadFileName(fileUrl, linkText, null);
}

/**
 * Файл с таким именем уже в inputs на Drive и его не нужно качать заново (кроме замены «шумного» маленького PDF).
 * @param {string} predictedName
 * @param {{ name?: string; id?: string; size?: string }[]} inputChildren
 * @param {Set<string>} existing
 */
function shouldSkipDownloadExistingOnDrive(predictedName, inputChildren, existing) {
  if (!existing.has(predictedName)) return false;
  const existingRow = inputChildren.find((f) => f.name === predictedName);
  if (!existingRow) return true;
  return !shouldReplaceSmallPdfOnDrive(existingRow, predictedName);
}

/**
 * Имя файла: из текста ссылки (как на IceTrade), иначе из URL / Content-Disposition.
 * @param {string} fileUrl
 * @param {string | undefined} linkText
 * @param {string | null} contentDisposition
 */
function resolveDownloadFileName(fileUrl, linkText, contentDisposition) {
  const t = linkText?.trim();
  if (t && /\.(pdf|docx?|zip|rar|7z|xlsx?|csv|txt|pptx?)$/i.test(t)) {
    return safeBasename(t);
  }
  let fileName = guessFileNameFromUrl(fileUrl);
  if (contentDisposition) {
    const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(contentDisposition);
    if (m) {
      try {
        fileName = decodeURIComponent(m[1].replace(/"/g, "").trim());
      } catch {
        fileName = m[1].replace(/"/g, "").trim();
      }
    }
  }
  if (!/\.(pdf|docx?|zip|rar|7z|xlsx?|csv|txt|pptx?)$/i.test(fileName)) {
    fileName = defaultIceTradeAttachmentFileName(fileUrl, linkText);
  }
  return safeBasename(fileName);
}

/**
 * @param {string} url
 * @param {string} tmpRoot
 * @param {number} timeoutMs
 * @param {string} refererPageUrl — карточка IceTrade (Referer для ссылок на icetrade.by; для goszakupki.by подставляется origin ЕИС)
 * @param {string | undefined} linkText
 */
async function downloadExternalToTemp(url, tmpRoot, timeoutMs, refererPageUrl, linkText) {
  const maxBytes = 45 * 1024 * 1024;
  const h = {
    ...icetradeFetchHeaders(),
    Accept: "*/*",
    Referer: downloadRefererForFileUrl(url, refererPageUrl),
  };
  const fileNameGuess = resolveDownloadFileName(url, linkText, null);
  const { buffer, contentDisposition, contentType } = await downloadIceTradeBinary(url, h, timeoutMs, {
    fileNameHint: fileNameGuess,
    cardPageUrl: refererPageUrl,
  });
  if (buffer.byteLength > maxBytes) throw new Error(`Файл слишком большой (${buffer.byteLength} байт)`);

  const fileName = resolveDownloadFileName(url, linkText, contentDisposition);
  const v = validateAttachmentBuffer(buffer, fileName, contentType, url);
  if (!v.ok) throw new Error(v.reason);
  const path = join(tmpRoot, `${Date.now()}-${fileName}`);
  await writeFile(path, buffer);
  return { path, fileName };
}

/** @param {number} ms */
function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Временный файл → Drive inputs/ (замена маленького PDF, дедуп по имени).
 * @param {object} p
 * @param {{ path: string, fileName: string }} p.dl
 * @param {{ name?: string; id?: string; size?: string }[]} p.inputChildren
 * @param {Set<string>} p.existing
 * @param {string} p.inputsId
 * @param {{ name: string; webViewLink?: string }[]} p.uploaded
 * @param {string[]} p.errors
 * @param {Set<string>} [p.skippedExistingSet] — уже в inputs, повторно не заливаем (и не считаем ошибкой).
 * @returns {Promise<boolean>} true — загружен новый файл
 */
async function consumeTempFileToInputs(p) {
  const { dl, inputChildren, existing, inputsId, uploaded, errors, skippedExistingSet } = p;
  const baseName = dl.fileName;
  const existingRow = inputChildren.find((f) => f.name === baseName);
  if (existing.has(baseName) && !existingRow) {
    skippedExistingSet?.add(baseName);
    await rm(dl.path, { force: true }).catch(() => {});
    return false;
  }
  if (existing.has(baseName) && existingRow) {
    if (shouldReplaceSmallPdfOnDrive(existingRow, baseName)) {
      try {
        await trashDriveFile(String(existingRow.id));
        existing.delete(baseName);
        const ix = inputChildren.findIndex((f) => f.name === baseName);
        if (ix >= 0) inputChildren.splice(ix, 1);
        errors.push(
          `Замена слишком маленького PDF на Drive: **${baseName}** (было **${driveFileSizeBytes(existingRow)}** B).`,
        );
      } catch (te) {
        errors.push(`Не удалось удалить старый **${baseName}**: ${te instanceof Error ? te.message : String(te)}`);
        await rm(dl.path, { force: true }).catch(() => {});
        return false;
      }
    } else {
      skippedExistingSet?.add(baseName);
      await rm(dl.path, { force: true }).catch(() => {});
      return false;
    }
  }
  const meta = await uploadFile(inputsId, dl.path, baseName);
  const metaObj = /** @type {{ name?: string; webViewLink?: string }} */ (meta);
  uploaded.push({
    name: metaObj.name ?? baseName,
    webViewLink: metaObj.webViewLink,
  });
  existing.add(baseName);
  await rm(dl.path, { force: true }).catch(() => {});
  return true;
}

/**
 * Повтор при обрыве TLS/HTTP; пауза между попытками растёт: retry_gap * номер_попытки.
 */
async function downloadExternalToTempWithRetry(url, tmpRoot, timeoutMs, refererPageUrl, linkText) {
  const retries = Math.max(
    1,
    Number.parseInt(process.env.LENA_ICETRADE_DOWNLOAD_RETRIES?.trim() ?? "3", 10) || 3,
  );
  const gap = Math.max(
    0,
    Number.parseInt(process.env.LENA_ICETRADE_DOWNLOAD_RETRY_GAP_MS?.trim() ?? "700", 10) || 700,
  );
  /** @type {unknown} */
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (attempt > 0) await sleepMs(gap * attempt);
      return await downloadExternalToTemp(url, tmpRoot, timeoutMs, refererPageUrl, linkText);
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr instanceof Error) throw lastErr;
  throw new Error(String(lastErr));
}

/**
 * @param {{ viewId: string, pageUrl: string, uploaded: { name: string, webViewLink?: string }[], candidates: { url: string, linkText?: string }[], errors: string[], cardFetchVia?: string, importSnapshot?: unknown, tenderFolderUrl?: string, inputsFolderUrl?: string, skippedExistingOnDrive?: string[] }} p
 */
function buildBootstrapMarkdown(p) {
  const {
    viewId,
    pageUrl,
    uploaded,
    candidates,
    errors,
    cardFetchVia,
    importSnapshot,
    tenderFolderUrl,
    inputsFolderUrl,
    skippedExistingOnDrive = [],
  } = p;
  const snap = /** @type {{ name?: string; webViewLink?: string } | null} */ (importSnapshot ?? null);
  return [
    `# IceTrade · bootstrap · view ${viewId}`,
    "",
    `- Карточка: ${pageUrl}`,
    ...(tenderFolderUrl ? [`- Папка тендера (Google Drive): ${tenderFolderUrl}`] : []),
    ...(inputsFolderUrl ? [`- Документы заказчика (**inputs/**): ${inputsFolderUrl}`] : []),
    ...(cardFetchVia ? [`- HTML карточки: получен через **${cardFetchVia}**`] : []),
    `- UTC: ${new Date().toISOString()}`,
    snap
      ? `- Снимок импорта (поля карточки, **события**): **inputs/${snap.name ?? "icetrade-import-snapshot.json"}**${snap.webViewLink ? ` (${snap.webViewLink})` : ""}`
      : `- Снимок импорта: **не загружен** — см. ошибки ниже`,
    "",
    "## Загружено в inputs (документы заказчика)",
    uploaded.length
      ? uploaded.map((u) => `- ${u.name}${u.webViewLink ? ` (${u.webViewLink})` : ""}`).join("\n")
      : "- _(автоматически не скачано — положите файлы вручную в inputs)_",
    "",
    ...(skippedExistingOnDrive.length
      ? [
          "## Уже в inputs на Drive (с сайта не качали повторно)",
          skippedExistingOnDrive.map((name) => `- ${name}`).join("\n"),
          "",
        ]
      : []),
    "## Кандидаты ссылок на странице",
    candidates.length
      ? candidates.map((c) => `- ${c.url}${c.linkText ? ` (${c.linkText})` : ""}`).join("\n")
      : "- _(не найдены — проверьте fetch/HTML; раздел «Аукционные документы» может отдаваться только полной страницей)_",
    "",
    "## Ошибки / предупреждения",
    errors.length ? errors.map((e) => `- ${e}`).join("\n") : "- нет",
    "",
    "## Что Лена не закроет без менеджера (проверить и запросить)",
    "",
    "- Коммерческое предложение и цена (НДС — как в документации закупки); см. §6d в LENA_RULES.",
    "- Справка банка / выписка — запросить у банка с параметрами из КД: **дата выдачи**, **против какой даты** актуальна сумма, **какой счёт** (если указано); если в КД нет явных сроков — попросить ориентир (часто: не ранее **1-го числа месяца** подачи заявки или **не старше 30 дней** до дня подачи — сверить с полным текстом).",
    "- Учредительные / регистрационные при необходимости (`_lena/founding-docs`).",
    "- Документы только с оригиналом / подписью, недоступные автоматически с ЭТП.",
    "- Подтверждение допусков, предмета, исключений из реестров.",
    "",
    "Зафиксируйте запросы и ответы в `telegram-managers-log.md` в папке этого тендера.",
    "",
  ].join("\n");
}

/**
 * Создаёт дерево тендера, качает вложения с HTML-карточки (эвристика), кладёт в inputs, пишет **inputs/icetrade-import-snapshot.json** (поля + события), добавляет notes/icetrade-bootstrap-*.md.
 * @param {string} userRootId — корень Drive (куда смотрит LENA_DRIVE_ROOT)
 * @param {string} urlOrText — URL или текст с URL / голый view id
 * @param {{ flat?: boolean, year?: string }} [opts]
 */
export async function bootstrapIceTradeToDrive(userRootId, urlOrText, opts = {}) {
  assertCredentialsFile();
  const flat = opts.flat === true;
  const year = opts.year;
  const maxFiles =
    Number.parseInt(process.env.LENA_ICETRADE_BOOT_MAX_FILES?.trim() ?? "30", 10) || 30;
  const timeoutMs =
    Number.parseInt(process.env.LENA_ICETRADE_FETCH_TIMEOUT_MS?.trim() ?? "25000", 10) || 25000;

  const viewId = normalizeIceTradeViewId(urlOrText);
  if (!viewId) {
    throw new Error("Не удалось определить id закупки IceTrade (ожидался URL …/view/<id> или число).");
  }

  const pageUrl = VIEW_PAGE(viewId);
  const { tender } = await ensureTenderTree(userRootId, viewId, { flat, year });
  const inputsId = tender.inputsId;

  /** @type {string | undefined} */
  let tenderRootWebViewLink;
  /** @type {string | undefined} */
  let inputsFolderWebViewLink;
  try {
    const tr = await getMetadata(tender.folderId);
    tenderRootWebViewLink = typeof tr.webViewLink === "string" ? tr.webViewLink : undefined;
    const ir = await getMetadata(inputsId);
    inputsFolderWebViewLink = typeof ir.webViewLink === "string" ? ir.webViewLink : undefined;
  } catch {
    tenderRootWebViewLink = undefined;
    inputsFolderWebViewLink = undefined;
  }

  const tmpRoot = await mkdtemp(join(tmpdir(), "lena-ice-"));
  /** @type {{ name: string, webViewLink?: string }[]} */
  const uploaded = [];
  /** @type {string[]} */
  const errors = [];

  let html = "";
  /** @type {string[]} */
  let networkFileUrls = [];
  /** @type {string | undefined} */
  let cardFetchVia;
  try {
    if (iceTradePlaywrightEnabled()) {
      try {
        const r = await fetchIceTradeCardHtmlPlaywright(pageUrl, timeoutMs);
        html = r.html;
        cardFetchVia = r.via;
        networkFileUrls = r.networkFileUrls ?? [];
        for (const w of r.warnings ?? []) errors.push(w);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Playwright (LENA_ICETRADE_PLAYWRIGHT): ${msg} — пробуем обычный HTTP.`);
        if (/Executable doesn't exist|ms-playwright/i.test(msg)) {
          errors.push(
            "Playwright: **Chromium не установлен** для учётной записи процесса (служба Windows → profile SYSTEM). В `.env`: **LENA_PLAYWRIGHT_BROWSERS_PATH=C:\\ProgramData\\ms-playwright**, затем `npx playwright install chromium` с этой переменной (см. **scripts/lena-server/install-windows.ps1**).",
          );
        }
        const r = await fetchIceTradeCardHtml(pageUrl, icetradeFetchHeaders(), timeoutMs);
        html = r.html;
        cardFetchVia = r.via;
        networkFileUrls = [];
        if (r.via !== "fetch") {
          errors.push(
            `Страница карточки: HTML загружен через **${r.via}** (встроенный fetch в Node не смог — типично для TLS/прокси на Windows).`,
          );
        }
      }
    } else {
      const r = await fetchIceTradeCardHtml(pageUrl, icetradeFetchHeaders(), timeoutMs);
      html = r.html;
      cardFetchVia = r.via;
      if (r.via !== "fetch") {
        errors.push(
          `Страница карточки: HTML загружен через **${r.via}** (встроенный fetch в Node не смог — типично для TLS/прокси на Windows).`,
        );
      }
    }
  } catch (e) {
    errors.push(`Страница карточки: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (html && isIceTradeLoginWallHtml(html)) {
    errors.push(
      "Похоже, вместо полной карточки пришёл HTML **с формой входа** (эвристика). Часто это редирект/ответ площадки на «неудобный» клиент, а не требование ЛК: во многих закупках файлы открываются и в инкогнито. Проверьте TLS/прокси, **User-Agent**, при необходимости **LENA_ICETRADE_PLAYWRIGHT** и таймауты.",
    );
  }

  function rebuildCandidates() {
    const fromHtmlInner = html ? extractAttachmentCandidates(html, pageUrl) : [];
    const seenUrlsInner = new Set(fromHtmlInner.map((c) => c.url));
    /** @type {{ url: string, linkText?: string }[]} */
    let cand = [...fromHtmlInner];
    for (const url of networkFileUrls) {
      if (seenUrlsInner.has(url)) continue;
      seenUrlsInner.add(url);
      cand.push({ url });
    }
    const beforePlatformFilterInner = cand;
    cand = cand.filter((c) => !isIceTradePlatformHelpAttachment(c.url, c.linkText, viewId));
    const removedAsPlatformInner = beforePlatformFilterInner.filter((c) =>
      isIceTradePlatformHelpAttachment(c.url, c.linkText, viewId),
    );
    return { candidates: cand, removedAsPlatform: removedAsPlatformInner };
  }

  let { candidates, removedAsPlatform } = rebuildCandidates();

  const pyMode = iceTradePythonFetchMode();
  if (pyMode === "always" || (pyMode === "auto" && candidates.length === 0)) {
    const pyR = await runPythonIceTradeFetch(viewId, timeoutMs);
    if (pyR.ok && pyR.urls.length > 0) {
      const seenP = new Set(networkFileUrls);
      let add = 0;
      for (const u of pyR.urls) {
        if (seenP.has(u)) continue;
        seenP.add(u);
        networkFileUrls.push(u);
        add += 1;
      }
      errors.push(
        `**Python (${pyR.via}):** распознано **${pyR.urls.length}** URL файлов; новых относительно Node — **${add}**.`,
      );
      if (add > 0) ({ candidates, removedAsPlatform } = rebuildCandidates());
    } else if (!pyR.ok) {
      errors.push(`Python (**icetrade_fetch**): ${pyR.error ?? "ошибка"}`);
    }
  }

  if (removedAsPlatform.length > 0) {
    errors.push(
      `Служебные вложения ЭТП (пропуск, **${removedAsPlatform.length}** шт.): ${removedAsPlatform.map((c) => c.url).join(" | ")}`,
    );
  }
  if (cardFetchVia === "playwright" && networkFileUrls.length > 0) {
    errors.push(
      `**Playwright / сеть (Node):** накоплено **${networkFileUrls.length}** URL из XHR; кандидатов к скачиванию после фильтра — **${candidates.length}**.`,
    );
  }
  // #region agent log
  _dbgAgentLog(
    "bootstrapDrive.js:candidates",
    "attachment candidates ready",
    {
      viewId,
      candidatesCount: candidates.length,
      cardFetchVia: cardFetchVia ?? null,
      networkFileUrlsCount: networkFileUrls.length,
      sampleUrls: candidates.slice(0, 3).map((c) => c.url),
    },
    "H3",
  );
  // #endregion
  let inputChildren = await listChildren(inputsId);
  const existing = new Set(inputChildren.map((f) => f.name));
  /** @type {Set<string>} */
  const skippedExistingSet = new Set();

  const SNAPSHOT_DRIVE_NAME = "icetrade-import-snapshot.json";
  /** @type {unknown} */
  let importSnapshotUpload = null;
  /** @type {ReturnType<typeof buildIceTradeImportSnapshot> | null} */
  let importSnapshotPayload = null;
  try {
    const snap = buildIceTradeImportSnapshot(html || "", { pageUrl, viewId, cardFetchVia });
    importSnapshotPayload = snap;
    for (const w of snap.warnings ?? []) {
      if (w) errors.push(`Снимок карточки: ${w}`);
    }
    if (snap.events?.some((e) => e?.severity === "cancel")) {
      errors.push(
        "Снимок карточки: в хронологии есть событие уровня **отмена / аннулирование** — проверьте актуальный статус закупки.",
      );
    }
    const snapLocal = join(tmpRoot, SNAPSHOT_DRIVE_NAME);
    await writeFile(snapLocal, importSnapshotToJson(snap), "utf8");
    const prevSnap = inputChildren.find((f) => f.name === SNAPSHOT_DRIVE_NAME);
    if (prevSnap?.id) {
      try {
        await trashDriveFile(prevSnap.id);
      } catch (e) {
        errors.push(`Корзина Drive (старый ${SNAPSHOT_DRIVE_NAME}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    importSnapshotUpload = await uploadFile(inputsId, snapLocal, SNAPSHOT_DRIVE_NAME);
    await rm(snapLocal, { force: true }).catch(() => {});
  } catch (e) {
    errors.push(`Снимок карточки (${SNAPSHOT_DRIVE_NAME}): ${e instanceof Error ? e.message : String(e)}`);
  }

  const betweenFiles = Math.max(
    0,
    Number.parseInt(process.env.LENA_ICETRADE_DOWNLOAD_GAP_MS?.trim() ?? "350", 10) || 350,
  );

  const rawPwDl = process.env.LENA_ICETRADE_PLAYWRIGHT_FILE_DOWNLOAD?.trim().toLowerCase() ?? "";
  const usePwBatchDl =
    iceTradePlaywrightEnabled() &&
    playwrightChromiumLikelyInstalled() &&
    rawPwDl !== "0" &&
    rawPwDl !== "false" &&
    rawPwDl !== "no" &&
    rawPwDl !== "off";
  if (iceTradePlaywrightEnabled() && !playwrightChromiumLikelyInstalled() && candidates.length > 0) {
    errors.push(
      "Playwright включён, но **Chromium не найден** — скачивание вложений идёт через HTTP/PowerShell (см. **LENA_PLAYWRIGHT_BROWSERS_PATH**). На Windows для getFile пробуется **PowerShell WebSession** (карточка → файл), как в браузере.",
    );
  }

  let n = 0;

  // #region agent log
  _dbgAgentLog(
    "bootstrapDrive.js:download-plan",
    "download backends selected",
    {
      runId: "post-fix",
      viewId,
      usePwBatchDl,
      playwrightEnabled: iceTradePlaywrightEnabled(),
      chromiumLikelyInstalled: playwrightChromiumLikelyInstalled(),
      platform: process.platform,
      cwd: process.cwd(),
      playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() ?? null,
      playwrightStorageSet: Boolean(process.env.LENA_ICETRADE_PLAYWRIGHT_STORAGE?.trim()),
      candidatesCount: candidates.length,
      existingInputsCount: existing.size,
    },
    "H2",
  );
  // #endregion

  if (usePwBatchDl && candidates.length > 0) {
    const uploadedBeforePwBatch = uploaded.length;
    try {
      await withPlaywrightIceTradeDownloadBatch(
        timeoutMs,
        pageUrl,
        async ({ requestBinary }) => {
        for (const item of candidates) {
          const fileUrl = item.url;
          if (n >= maxFiles) {
            errors.push(`Достигнут лимит файлов (${maxFiles}), остальное пропущено.`);
            break;
          }
          try {
            const predicted = predictInputFileNameBeforeDownload(fileUrl, item.linkText);
            if (shouldSkipDownloadExistingOnDrive(predicted, inputChildren, existing)) {
              skippedExistingSet.add(predicted);
              continue;
            }
            if (n > 0 && betweenFiles > 0) await sleepMs(betweenFiles);
            const { buffer, contentType, contentDisposition } = await requestBinary(fileUrl, pageUrl);
            const maxBytes = 45 * 1024 * 1024;
            if (buffer.byteLength > maxBytes) throw new Error(`Файл слишком большой (${buffer.byteLength} байт)`);
            const baseName = resolveDownloadFileName(fileUrl, item.linkText, contentDisposition);
            const v = validateAttachmentBuffer(buffer, baseName, contentType, fileUrl);
            if (!v.ok) throw new Error(v.reason);
            const dlPath = join(tmpRoot, `pw-${Date.now()}-${baseName}`);
            await writeFile(dlPath, buffer);
            const uploadedOk = await consumeTempFileToInputs({
              dl: { path: dlPath, fileName: baseName },
              inputChildren,
              existing,
              inputsId,
              uploaded,
              errors,
              skippedExistingSet,
            });
            if (uploadedOk) n += 1;
          } catch (e) {
            errors.push(`${fileUrl}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      },
        { viewId },
      );
      const pwUploadedDelta = uploaded.length - uploadedBeforePwBatch;
      if (pwUploadedDelta === 0) {
        errors.push(
          "Playwright batch: **0** вложений загружено — пробуем PowerShell WebSession и HTTP по одному файлу.",
        );
      }
      // #region agent log
      _dbgAgentLog(
        "bootstrapDrive.js:pw-batch-done",
        "playwright batch finished without throw",
        {
          runId: "post-fix",
          viewId,
          uploadedBeforePwBatch,
          uploadedAfterPwBatch: uploaded.length,
          uploadedDelta: pwUploadedDelta,
          nAfterPwBatch: n,
        },
        "H1",
      );
      // #endregion
    } catch (e) {
      // #region agent log
      _dbgAgentLog(
        "bootstrapDrive.js:pw-batch-error",
        "playwright batch threw",
        {
          runId: "post-fix",
          viewId,
          error: e instanceof Error ? e.message : String(e),
        },
        "H1",
      );
      // #endregion
      errors.push(
        `Скачивание вложений через Playwright: ${e instanceof Error ? e.message : String(e)} — повтор PowerShell / HTTP.`,
      );
    }
  }

  if (candidates.length > 0 && process.platform === "win32") {
    /** @type {{ id: string, url: string, fileName: string, linkText?: string }[]} */
    const batchItems = [];
    /** @type {Map<string, { url: string, linkText?: string }>} */
    const batchById = new Map();
    let bi = 0;
    for (const item of candidates) {
      if (batchItems.length >= maxFiles) break;
      const predicted = predictInputFileNameBeforeDownload(item.url, item.linkText);
      if (shouldSkipDownloadExistingOnDrive(predicted, inputChildren, existing)) {
        skippedExistingSet.add(predicted);
        continue;
      }
      const id = String(bi++);
      batchItems.push({
        id,
        url: item.url,
        fileName: predicted,
        linkText: item.linkText,
      });
      batchById.set(id, item);
    }
    if (batchItems.length > 0) {
      // #region agent log
      _dbgAgentLog(
        "bootstrapDrive.js:ps-batch-start",
        "powershell batch starting",
        {
          runId: "post-fix",
          viewId,
          batchItemsCount: batchItems.length,
        },
        "H4",
      );
      // #endregion
      try {
        const d = await mkdtemp(join(tmpRoot, "ps-batch-"));
        const h = icetradeFetchHeaders();
        const results = await downloadIceTradeBatchViaPowerShellSession(
          pageUrl,
          batchItems,
          d,
          timeoutMs,
          h,
        );
        let okCnt = 0;
        for (const r of results) {
          const src = batchById.get(String(r.id));
          if (!src) continue;
          if (!r.ok || !r.path) {
            errors.push(`${src.url}: PowerShell batch: ${r.error ?? "ошибка"}`);
            continue;
          }
          try {
            const buf = await readFile(r.path);
            const baseName = resolveDownloadFileName(src.url, src.linkText, null);
            const v = validateAttachmentBuffer(buf, baseName, null, src.url);
            if (!v.ok) {
              errors.push(`${src.url}: ${v.reason}`);
              continue;
            }
            const dlPath = join(tmpRoot, `ps-${Date.now()}-${baseName}`);
            await writeFile(dlPath, buf);
            const uploadedOk = await consumeTempFileToInputs({
              dl: { path: dlPath, fileName: baseName },
              inputChildren,
              existing,
              inputsId,
              uploaded,
              errors,
              skippedExistingSet,
            });
            if (uploadedOk) {
              n += 1;
              okCnt += 1;
            }
          } catch (e) {
            errors.push(`${src.url}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (okCnt > 0) {
          errors.push(`**PowerShell batch (WebSession):** загружено **${okCnt}** из **${batchItems.length}** вложений.`);
        }
        // #region agent log
        _dbgAgentLog(
          "bootstrapDrive.js:ps-batch-done",
          "powershell batch finished",
          {
            runId: "post-fix",
            viewId,
            okCnt,
            batchItemsCount: batchItems.length,
            resultsCount: results.length,
            psErrors: results.filter((r) => !r.ok).slice(0, 3).map((r) => r.error ?? "err"),
          },
          "H4",
        );
        // #endregion
        await rm(d, { recursive: true, force: true }).catch(() => {});
      } catch (e) {
        // #region agent log
        _dbgAgentLog(
          "bootstrapDrive.js:ps-batch-error",
          "powershell batch threw",
          {
            viewId,
            error: e instanceof Error ? e.message : String(e),
          },
          "H4",
        );
        // #endregion
        errors.push(
          `PowerShell batch (WebSession): ${e instanceof Error ? e.message : String(e)} — пробуем по одному файлу.`,
        );
      }
    }
  }

  for (const item of candidates) {
    const fileUrl = item.url;
    if (n >= maxFiles) {
      errors.push(`Достигнут лимит файлов (${maxFiles}), остальное пропущено.`);
      break;
    }
    try {
      const predicted = predictInputFileNameBeforeDownload(fileUrl, item.linkText);
      if (shouldSkipDownloadExistingOnDrive(predicted, inputChildren, existing)) {
        skippedExistingSet.add(predicted);
        continue;
      }
      if (n > 0 && betweenFiles > 0) await sleepMs(betweenFiles);
      const dl = await downloadExternalToTempWithRetry(fileUrl, tmpRoot, timeoutMs, pageUrl, item.linkText);
      const uploadedOk = await consumeTempFileToInputs({
        dl,
        inputChildren,
        existing,
        inputsId,
        uploaded,
        errors,
        skippedExistingSet,
      });
      if (uploadedOk) n += 1;
    } catch (e) {
      errors.push(`${fileUrl}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const skippedExistingOnDrive = [...skippedExistingSet].sort((a, b) => a.localeCompare(b));
  const noteName = `icetrade-bootstrap-${viewId}-${stamp}.md`;
  const noteMd = buildBootstrapMarkdown({
    viewId,
    pageUrl,
    uploaded,
    candidates,
    errors,
    cardFetchVia,
    importSnapshot: importSnapshotUpload,
    tenderFolderUrl: tenderRootWebViewLink,
    inputsFolderUrl: inputsFolderWebViewLink,
    skippedExistingOnDrive,
  });
  const notePath = join(tmpRoot, noteName);
  await writeFile(notePath, noteMd, "utf8");

  /** @type {unknown} */
  let noteUpload = null;
  try {
    noteUpload = await uploadFile(tender.notesId, notePath, noteName);
  } catch (e) {
    errors.push(`Загрузка заметки: ${e instanceof Error ? e.message : String(e)}`);
  }

  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

  // #region agent log
  _dbgAgentLog(
    "bootstrapDrive.js:final",
    "bootstrap complete",
    {
      runId: "post-fix",
      viewId,
      uploadedCount: uploaded.length,
      uploadedNames: uploaded.map((u) => u.name),
      candidatesCount: candidates.length,
      skippedExistingCount: skippedExistingOnDrive.length,
      errorsCount: errors.length,
      errorSamples: errors.slice(0, 5).map((e) => String(e).slice(0, 200)),
    },
    "H5",
  );
  // #endregion

  return {
    viewId,
    tenderId: viewId,
    tenderRootFolderId: tender.folderId,
    tenderRootWebViewLink,
    inputsFolderId: inputsId,
    inputsFolderWebViewLink,
    notesFolderId: tender.notesId,
    uploaded,
    candidateUrls: candidates,
    cardFetchVia,
    errors,
    noteFile: noteUpload,
    importSnapshotFile: importSnapshotUpload,
    iceTradeUrl: pageUrl,
    alternateIdsInMessage: extractIceTradeViewIds(urlOrText).filter((x) => x !== viewId),
    skippedExistingOnDrive,
    importSnapshot: importSnapshotPayload,
  };
}
