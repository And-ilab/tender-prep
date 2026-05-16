import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertCredentialsFile } from "../drive/config.js";
import { listChildren, uploadFile } from "../drive/ops.js";
import { ensureTenderTree } from "../drive/workspace.js";
import { extractIceTradeViewIds, normalizeIceTradeViewId } from "./viewIds.js";
import { fetchIceTradeCardHtml, downloadIceTradeBinary } from "./fetchPage.js";
import { fetchIceTradeCardHtmlPlaywright, iceTradePlaywrightEnabled } from "./fetchPageRendered.js";
import { iceTradePythonFetchMode, runPythonIceTradeFetch } from "./bootstrapPythonSidecar.js";
import { extractAttachmentCandidates, isIceTradeLoginWallHtml, isIceTradePlatformHelpAttachment } from "./scrapeAttachments.js";

const VIEW_PAGE = (/** @type {string} */ id) => `https://icetrade.by/tenders/all/view/${id}`;

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
  const { buffer, contentDisposition } = await downloadIceTradeBinary(url, h, timeoutMs);
  if (buffer.byteLength > maxBytes) throw new Error(`Файл слишком большой (${buffer.byteLength} байт)`);

  const fileName = resolveDownloadFileName(url, linkText, contentDisposition);
  const path = join(tmpRoot, `${Date.now()}-${fileName}`);
  await writeFile(path, buffer);
  return { path, fileName };
}

/** @param {number} ms */
function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
 * @param {{ viewId: string, pageUrl: string, uploaded: { name: string, webViewLink?: string }[], candidates: { url: string, linkText?: string }[], errors: string[], cardFetchVia?: string }} p
 */
function buildBootstrapMarkdown(p) {
  const { viewId, pageUrl, uploaded, candidates, errors, cardFetchVia } = p;
  return [
    `# IceTrade · bootstrap · view ${viewId}`,
    "",
    `- Карточка: ${pageUrl}`,
    ...(cardFetchVia ? [`- HTML карточки: получен через **${cardFetchVia}**`] : []),
    `- UTC: ${new Date().toISOString()}`,
    "",
    "## Загружено в inputs (документы заказчика)",
    uploaded.length
      ? uploaded.map((u) => `- ${u.name}${u.webViewLink ? ` (${u.webViewLink})` : ""}`).join("\n")
      : "- _(автоматически не скачано — положите файлы вручную в inputs)_",
    "",
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
    "- Справка банка, выписки, отчётность — если требует закупка; универсальные файлы в `_lena/org-docs`.",
    "- Учредительные / регистрационные при необходимости (`_lena/founding-docs`).",
    "- Документы только с оригиналом / подписью, недоступные автоматически с ЭТП.",
    "- Подтверждение допусков, предмета, исключений из реестров.",
    "",
    "Зафиксируйте запросы и ответы в `telegram-managers-log.md` в папке этого тендера.",
    "",
  ].join("\n");
}

/**
 * Создаёт дерево тендера, качает вложения с HTML-карточки (эвристика), кладёт в inputs, добавляет notes/icetrade-bootstrap-*.md.
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
      "Похоже, вместо карточки пришла **только страница входа** (редирект на логин для этой закупки или другой ответ CDN). Вложения на IceTrade часто **публичные** — если в браузере без входа файлы открываются, проверьте **fetch** с машины бота (TLS/прокси) и повторите.",
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
  const inputsId = tender.inputsId;
  const existing = new Set((await listChildren(inputsId)).map((f) => f.name));

  const betweenFiles = Math.max(
    0,
    Number.parseInt(process.env.LENA_ICETRADE_DOWNLOAD_GAP_MS?.trim() ?? "350", 10) || 350,
  );

  let n = 0;
  for (const item of candidates) {
    const fileUrl = item.url;
    if (n >= maxFiles) {
      errors.push(`Достигнут лимит файлов (${maxFiles}), остальное пропущено.`);
      break;
    }
    try {
      if (n > 0 && betweenFiles > 0) await sleepMs(betweenFiles);
      const dl = await downloadExternalToTempWithRetry(fileUrl, tmpRoot, timeoutMs, pageUrl, item.linkText);
      const baseName = dl.fileName;
      if (existing.has(baseName)) {
        errors.push(`Уже есть на Drive: ${baseName}`);
        await rm(dl.path, { force: true }).catch(() => {});
        continue;
      }
      const meta = await uploadFile(inputsId, dl.path, baseName);
      const metaObj = /** @type {{ name?: string; webViewLink?: string }} */ (meta);
      uploaded.push({
        name: metaObj.name ?? baseName,
        webViewLink: metaObj.webViewLink,
      });
      existing.add(baseName);
      n += 1;
      await rm(dl.path, { force: true }).catch(() => {});
    } catch (e) {
      errors.push(`${fileUrl}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const noteName = `icetrade-bootstrap-${viewId}-${stamp}.md`;
  const noteMd = buildBootstrapMarkdown({
    viewId,
    pageUrl,
    uploaded,
    candidates,
    errors,
    cardFetchVia,
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

  return {
    viewId,
    tenderId: viewId,
    tenderRootFolderId: tender.folderId,
    inputsFolderId: inputsId,
    notesFolderId: tender.notesId,
    uploaded,
    candidateUrls: candidates,
    cardFetchVia,
    errors,
    noteFile: noteUpload,
    iceTradeUrl: pageUrl,
    alternateIdsInMessage: extractIceTradeViewIds(urlOrText).filter((x) => x !== viewId),
  };
}
