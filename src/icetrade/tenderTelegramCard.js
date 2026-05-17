import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertCredentialsFile } from "../drive/config.js";
import { chatCompletion, isLlmConfigured } from "../llm/openaiCompatible.js";
import { uploadFile } from "../drive/ops.js";
import { ensureTenderTree } from "../drive/workspace.js";
import { fetchIceTradeCardHtml } from "./fetchPage.js";
import {
  extractTenderInputDocumentsToExtracted,
  resolveTenderDocumentCorpus,
} from "./inputDocumentsExtract.js";

const VIEW_PAGE = (/** @type {string} */ id) => `https://icetrade.by/tenders/all/view/${id}`;

function icetradeHtmlHeaders() {
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

/**
 * @param {string} html
 */
function roughStripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} raw
 */
function parseLlmJson(raw) {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  return /** @type {Record<string, unknown>} */ (JSON.parse(s));
}

/**
 * @param {Record<string, unknown>} o
 */
function normalizeCard(o) {
  const tenderTitle = typeof o.tenderTitle === "string" ? o.tenderTitle.trim() : "";
  const priceInfo = typeof o.priceInfo === "string" ? o.priceInfo.trim() : "";
  const submissionDeadline = typeof o.submissionDeadline === "string" ? o.submissionDeadline.trim() : "";
  /** @type {string[]} */
  const requiredDocumentNames = [];
  const arr = o.requiredDocumentNames;
  if (Array.isArray(arr)) {
    for (const x of arr) {
      if (typeof x !== "string") continue;
      const t = x.trim();
      if (t) requiredDocumentNames.push(t);
    }
  }
  return { tenderTitle, priceInfo, submissionDeadline, requiredDocumentNames };
}

/**
 * @param {Awaited<ReturnType<typeof buildTenderTelegramCard>>} r
 */
export function formatTenderTelegramCardForTelegram(r) {
  if (!r.ok) {
    return `**Карточка тендера:** не сформирована — ${r.error ?? "ошибка"}`;
  }
  const { structured, extractedChars, usedIceTradeHtml, skippedIceHtml } = r;
  const docs =
    structured.requiredDocumentNames.length > 0
      ? structured.requiredDocumentNames.map((n, i) => `${i + 1}. ${n}`).join("\n")
      : "_(по тексту не выделено — проверьте вручную)_";

  const lines = [
    "**Карточка закупки**",
    "",
    `**Наименование:** ${structured.tenderTitle || "—"}`,
    `**Цена / бюджет:** ${structured.priceInfo || "—"}`,
    `**Срок подачи:** ${structured.submissionDeadline || "—"}`,
    "",
    "**Документы к составу заявки (названия):**",
    docs,
    "",
    `_(Извлечено символов из комплекта: **${extractedChars}**; фрагмент HTML IceTrade: ${usedIceTradeHtml ? "да" : "нет"}${skippedIceHtml ? ` (${skippedIceHtml})` : ""}. Черновик для менеджера.)_`,
  ];
  return lines.join("\n").trim();
}

function buildCardMarkdown(tenderId, structured, meta) {
  const lines = [
    `# Карточка тендера (Telegram) · ${tenderId}`,
    "",
    `- UTC: ${new Date().toISOString()}`,
    `- Символов извлечённого текста: ${meta.extractedChars}`,
    `- HTML IceTrade: ${meta.usedIceTradeHtml ? "да" : "нет"}`,
    "",
    "## Наименование",
    structured.tenderTitle || "—",
    "",
    "## Цена / бюджет",
    structured.priceInfo || "—",
    "",
    "## Срок подачи",
    structured.submissionDeadline || "—",
    "",
    "## Документы к составу заявки",
    structured.requiredDocumentNames.length
      ? structured.requiredDocumentNames.map((n) => `- ${n}`).join("\n")
      : "—",
    "",
  ];
  return lines.join("\n");
}

/**
 * Карточка для Telegram: **только LLM** по тексту из **`inputs/extracted`** (если этап парсинга создал зону extract)
 * или по **нативному тексту** прямо в **`inputs/`**, если все файлы — plain/text без PDF/DOC.
 * + опционально фрагмент HTML IceTrade.
 *
 * Совмещённый режим: `runExtract: true` или `LENA_TENDER_CARD_RUN_EXTRACT=1`, либо CLI `tender-card --extract`.
 *
 * @param {string} userRootId
 * @param {string} tenderId — папка тендера / view IceTrade
 * @param {{ flat?: boolean; year?: string; runExtract?: boolean }} [opts]
 */
export async function buildTenderTelegramCard(userRootId, tenderId, opts = {}) {
  assertCredentialsFile();
  if (!isLlmConfigured()) {
    return {
      ok: false,
      error: "Нужен LENA_OPENAI_API_KEY или OPENAI_API_KEY.",
    };
  }

  const { tender } = await ensureTenderTree(userRootId, tenderId, opts);
  const notesId = tender.notesId;

  const envRun = process.env.LENA_TENDER_CARD_RUN_EXTRACT?.trim().toLowerCase() ?? "";
  const runExtract =
    opts.runExtract === true ||
    envRun === "1" ||
    envRun === "true" ||
    envRun === "yes" ||
    envRun === "on";

  /** @type {string | undefined} */
  let extractError;
  if (runExtract) {
    try {
      await extractTenderInputDocumentsToExtracted(userRootId, tenderId, opts);
    } catch (e) {
      extractError = e instanceof Error ? e.message : String(e);
    }
  }

  const maxCorpus =
    Number.parseInt(process.env.LENA_TENDER_CARD_MAX_CORPUS_CHARS?.trim() ?? "95000", 10) || 95_000;
  const { source: corpusSource, text: corpus } = await resolveTenderDocumentCorpus(
    tender.inputsId,
    maxCorpus,
  );
  const extractedChars = corpus.replace(/\s+/g, " ").trim().length;

  let usedIceTradeHtml = false;
  /** @type {string | undefined} */
  let skippedIceHtml;
  let iceText = "";
  const fetchMs =
    Number.parseInt(process.env.LENA_TENDER_CARD_ICETRADE_FETCH_MS?.trim() ?? "22000", 10) || 22_000;
  if (!/^\d{5,12}$/.test(tenderId.trim())) {
    skippedIceHtml = "tender_id не числовой — HTML карточки не запрашивали";
  } else {
    try {
      const pageUrl = VIEW_PAGE(tenderId.trim());
      const { html } = await fetchIceTradeCardHtml(pageUrl, icetradeHtmlHeaders(), fetchMs);
      usedIceTradeHtml = true;
      iceText = roughStripHtml(html).slice(0, 18_000);
      if (!iceText.length) {
        skippedIceHtml = "получен пустой текст после strip";
      }
    } catch (e) {
      skippedIceHtml = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
    }
  }

  const minChars =
    Number.parseInt(process.env.LENA_TENDER_CARD_MIN_INPUT_CHARS?.trim() ?? "400", 10) || 400;
  const combinedLen = corpus.length + iceText.length;
  if (combinedLen < minChars) {
    return {
      ok: false,
      error: [
        `Мало текста для карточки (~${combinedLen} симв., нужно ≥${minChars}).`,
        extractError ? `Извлечение: ${extractError}` : "",
        "Сначала **парсинг**: CLI `tenders tender-extract …` или в Telegram **/tenderextract** (статус — `tender-pipeline-state.json` в корне тендера). Либо `tender-card --extract`.",
      ]
        .filter(Boolean)
        .join(" "),
      extractedChars,
      usedIceTradeHtml,
      skippedIceHtml,
    };
  }

  const system = [
    "Ты «Лена» — специалист по тендерам (IceTrade, РБ). Ответь **только JSON** без Markdown.",
    "Задача: по фрагментам документов закупки и неформатированному тексту с карточки площадки заполнить поля.",
    "Правила:",
    "- tenderTitle — краткое наименование закупки/предмет (если в тексте нет — пустая строка).",
    "- priceInfo — одна строка: начальная (макс.) цена, НМЦ, бюджет, либо «не указано в предоставленном тексте». Не выдумывай цифр.",
    "- submissionDeadline — срок/дата подачи заявок **как в тексте** (дата и время, если есть; иначе фраза из извещения или пусто).",
    "- requiredDocumentNames — **только названия документов**, которые **участник должен включить в заявку** (заявления, справки, КП, копии и т.д.) по перечню из документации. Без дубликатов, без пояснений в строках. Если в тексте нет явного перечня — пустой массив.",
    "- Не добавляй документов, которых нет во входном тексте.",
    "Форма:",
    '{"tenderTitle":"","priceInfo":"","submissionDeadline":"","requiredDocumentNames":[]}',
  ].join(" ");

  const userContent = [
    `tender_id / view: ${tenderId}`,
    extractError ? `\n(Извлечение: ${extractError})\n` : "",
    corpusSource === "extracted"
      ? "### Текст из документов закупки (inputs/extracted)"
      : "### Текст из документов закупки (только нативный текст в inputs/)",
    corpus || "_(пусто)_",
    "",
    "### Фрагмент карточки IceTrade (только текст)",
    iceText || "_(нет)_",
  ].join("\n");

  let rawLlm = "";
  let structured = normalizeCard({});
  try {
    rawLlm = await chatCompletion(
      [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      { temperature: 0.2, max_tokens: 3500 },
    );
    structured = normalizeCard(parseLlmJson(rawLlm));
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      rawLlm: rawLlm.slice(0, 1200),
      extractedChars,
      usedIceTradeHtml,
      skippedIceHtml,
    };
  }

  const meta = { extractedChars, usedIceTradeHtml };
  const md = buildCardMarkdown(tenderId, structured, meta);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const noteName = `tender-card-${tenderId}-${stamp}.md`;
  const tmp = await mkdtemp(join(tmpdir(), "lena-tcard-"));
  const notePath = join(tmp, noteName);
  /** @type {Record<string, unknown> | null} */
  let noteFile = null;
  /** @type {string | undefined} */
  let noteUploadError;
  try {
    await writeFile(notePath, md, "utf8");
    try {
      noteFile = await uploadFile(notesId, notePath, noteName);
    } catch (ue) {
      noteUploadError = ue instanceof Error ? ue.message : String(ue);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  return {
    ok: true,
    structured,
    extractedChars,
    usedIceTradeHtml,
    skippedIceHtml,
    extractError,
    noteFile,
    noteUploadError,
    tenderNotesFolderId: notesId,
  };
}