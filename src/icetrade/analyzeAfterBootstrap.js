import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";

import { assertCredentialsFile } from "../drive/config.js";
import {
  downloadFile,
  exportGoogleFile,
  getMetadata,
  listChildren,
  uploadFile,
} from "../drive/ops.js";
import { ensureTenderTree } from "../drive/workspace.js";
import { chatCompletion, isLlmConfigured } from "../llm/openaiCompatible.js";
import { jsonrepair } from "jsonrepair";
import { runQuery } from "../rag/queryLocal.js";
import { buildParsedInputsCorpus } from "../analysis/parsedInputsCorpus.js";
import {
  buildPreparationPromptMarkdown,
  PREPARATION_PROMPT_FILENAME,
  replacePreparationPromptFile,
} from "../analysis/preparationPromptFromAnalysis.js";
import {
  corpusMentionsPriceReductionProcedure,
  corpusSuggestsAbsurdStatedPrice,
} from "../analysis/pricingPolicy.js";
import { formatAnalysisMatrixBullets } from "../analysis/analysisMatrixBullets.js";
import {
  buildSnapshotCorpusAugmentation,
  readIceTradeImportSnapshot,
  snapshotBidsDeadlineHint,
  snapshotProcedureBudgetHint,
} from "../analysis/cpSnapshotHints.js";

function safeSliceName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]+/g, "_")
    .slice(0, 120)
    .trim() || "file";
}

/**
 * @param {string} indexDirAbs
 */
async function ragDirReady(indexDirAbs) {
  try {
    const { access } = await import("node:fs/promises");
    const { join: j } = await import("node:path");
    await access(j(indexDirAbs, "manifest.json"));
    await access(j(indexDirAbs, "chunks.jsonl"));
    return true;
  } catch {
    return false;
  }
}

function resolvedRagIndexDir() {
  const raw = process.env.LENA_RAG_INDEX_DIR?.trim();
  if (!raw) return null;
  return pathResolve(raw);
}

/** RAG в промпт анализа после bootstrap (по умолчанию выкл.; вкл.: LENA_ICETRADE_ANALYZE_USE_RAG=1). */
function isIcetradeAnalyzeRagEnabled() {
  const v = process.env.LENA_ICETRADE_ANALYZE_USE_RAG?.trim().toLowerCase() ?? "";
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Строгая привязка списков к тексту inputs (по умолчанию вкл.; выкл.: LENA_ICETRADE_ANALYZE_STRICT_GROUNDING=0). */
function isAnalyzeGroundingStrict() {
  const v = process.env.LENA_ICETRADE_ANALYZE_STRICT_GROUNDING?.trim().toLowerCase() ?? "";
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/**
 * @param {string} fileId
 * @param {string} name
 * @param {string} [mimeType]
 * @param {string} tmpRoot
 * @returns {Promise<string | null>}
 */
async function extractTextSnippet(fileId, name, mimeType, tmpRoot) {
  const low = name.toLowerCase();
  const safe = safeSliceName(name);
  const dest = join(tmpRoot, `ex-${fileId.slice(0, 12)}-${safe}`);
  try {
    if (mimeType === "application/vnd.google-apps.folder") return null;
    if (mimeType === "application/vnd.google-apps.document") {
      await exportGoogleFile(fileId, "text/plain", dest);
      return (await readFile(dest, "utf8")).slice(0, 14_000);
    }
    if (mimeType === "application/vnd.google-apps.spreadsheet") {
      await exportGoogleFile(fileId, "text/csv", dest);
      return (await readFile(dest, "utf8")).slice(0, 14_000);
    }
    if (
      mimeType?.startsWith("text/") ||
      /\.(txt|md|csv|log|json|xml|html)$/i.test(low)
    ) {
      await downloadFile(fileId, dest);
      return (await readFile(dest, "utf8")).slice(0, 14_000);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Разбор JSON от LLM: часты хвостовые запятые, кавычки/переносы в цитатах — без ремонта парсинг падает,
 * хотя извлечение текста из PDF прошло успешно.
 * @param {string} raw
 */
function parseLlmJson(raw) {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);

  /** @param {string} x */
  const stripTrailingCommas = (x) => {
    let cur = x;
    for (let n = 0; n < 8; n += 1) {
      const next = cur.replace(/,\s*([}\]])/g, "$1");
      if (next === cur) break;
      cur = next;
    }
    return cur;
  };

  /** @param {string} x */
  const tryParse = (x) => /** @type {Record<string, unknown>} */ (JSON.parse(x));

  try {
    return tryParse(s);
  } catch (eFirst) {
    try {
      return tryParse(stripTrailingCommas(s));
    } catch {
      try {
        return tryParse(jsonrepair(stripTrailingCommas(s)));
      } catch {
        try {
          return tryParse(jsonrepair(s));
        } catch {
          throw eFirst;
        }
      }
    }
  }
}

/**
 * Узкая нормализация пробелов для проверки «цитата из корпуса».
 * @param {string} s
 */
function collapseWs(s) {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Нормализация для сопоставления цитаты с корпусом (неразрывный пробел, кавычки).
 * @param {string} s
 */
function normalizeForEvidenceMatch(s) {
  return collapseWs(
    String(s)
      .replace(/\u00a0/g, " ")
      .replace(/[«»„“”]/g, '"')
      .replace(/[’′]/g, "'"),
  );
}

/**
 * Есть ли во фрагменте документов подстрока, совпадающая с цитатой (после схлопывания пробелов).
 * @param {string} evidence
 * @param {string} corpus
 */
function evidenceAppearsInCorpus(evidence, corpus) {
  const e = normalizeForEvidenceMatch(evidence);
  const c = normalizeForEvidenceMatch(corpus);
  if (e.length < 14) return false;
  if (c.includes(e)) return true;
  const head = e.slice(0, Math.min(96, e.length));
  return head.length >= 14 && c.includes(head);
}

/**
 * @param {Record<string, unknown>} o
 */
function normalizeAnalysis(o) {
  const tenderTitle = typeof o.tenderTitle === "string" ? o.tenderTitle.trim() : null;
  const sumOrBudget = typeof o.sumOrBudget === "string" ? o.sumOrBudget.trim() : null;
  const submissionOverview =
    typeof o.submissionOverview === "string" ? o.submissionOverview.trim() : null;
  const submissionMethod =
    typeof o.submissionMethod === "string" ? o.submissionMethod.trim() : null;
  const submissionDeadline =
    typeof o.submissionDeadline === "string" ? o.submissionDeadline.trim() : null;

  /** @type {{ name: string; basis: string; evidence: string }[]} */
  const lenaCanPrepare = [];
  /** @type {{ name: string; reason: string; criteria: string; evidence: string }[]} */
  const managerMustProvide = [];

  const a = typeof o.lenaCanPrepare === "object" && o.lenaCanPrepare !== null ? o.lenaCanPrepare : [];
  const b =
    typeof o.managerMustProvide === "object" && o.managerMustProvide !== null
      ? o.managerMustProvide
      : [];

  if (Array.isArray(a)) {
    for (const x of a) {
      if (!x || typeof x !== "object") continue;
      const name = typeof /** @type {{ name?: string }} */ (x).name === "string" ? x.name.trim() : "";
      const basis =
        typeof /** @type {{ basis?: string }} */ (x).basis === "string" ? x.basis.trim() : "";
      const evidence =
        typeof /** @type {{ evidence?: string }} */ (x).evidence === "string" ? x.evidence.trim() : "";
      if (name) lenaCanPrepare.push({ name, basis: basis || "—", evidence });
    }
  }
  if (Array.isArray(b)) {
    for (const x of b) {
      if (!x || typeof x !== "object") continue;
      const name = typeof /** @type {{ name?: string }} */ (x).name === "string" ? x.name.trim() : "";
      const reason =
        typeof /** @type {{ reason?: string }} */ (x).reason === "string" ? x.reason.trim() : "";
      const criteria =
        typeof /** @type {{ criteria?: string }} */ (x).criteria === "string" ? x.criteria.trim() : "";
      const evidence =
        typeof /** @type {{ evidence?: string }} */ (x).evidence === "string" ? x.evidence.trim() : "";
      if (name) managerMustProvide.push({ name, reason: reason || "—", criteria, evidence });
    }
  }

  return {
    tenderTitle: tenderTitle || null,
    sumOrBudget: sumOrBudget || null,
    submissionOverview: submissionOverview || null,
    submissionMethod: submissionMethod || null,
    submissionDeadline: submissionDeadline || null,
    lenaCanPrepare,
    managerMustProvide,
  };
}

/**
 * Только пункты с цитатой из корпуса (фрагменты inputs: файлы + снимок карточки IceTrade).
 * @param {ReturnType<typeof normalizeAnalysis>} structured
 * @param {string} corpus
 */
function keepOnlyCorpusGrounded(structured, corpus) {
  const strict = isAnalyzeGroundingStrict();

  if (!strict || !corpus.trim()) {
    return {
      ...structured,
      lenaCanPrepare: structured.lenaCanPrepare.map(({ name, basis }) => ({ name, basis })),
      managerMustProvide: structured.managerMustProvide.map(({ name, reason, criteria }) => ({
        name,
        reason,
        criteria,
      })),
    };
  }

  /** @type {{ name: string; basis: string }[]} */
  const lenaOk = [];
  for (const x of structured.lenaCanPrepare) {
    if (evidenceAppearsInCorpus(x.evidence, corpus)) lenaOk.push({ name: x.name, basis: x.basis });
  }

  /** @type {{ name: string; reason: string; criteria: string }[]} */
  const mgrOk = [];
  for (const x of structured.managerMustProvide) {
    if (!evidenceAppearsInCorpus(x.evidence, corpus)) continue;
    let criteria = x.criteria;
    if (criteria && !evidenceAppearsInCorpus(criteria, corpus) && criteria !== "—") {
      const critTrim = collapseWs(criteria);
      if (critTrim.length >= 14 && !evidenceAppearsInCorpus(critTrim, corpus)) criteria = null;
    }
    mgrOk.push({ name: x.name, reason: x.reason, criteria: criteria || "—" });
  }

  return {
    ...structured,
    lenaCanPrepare: lenaOk,
    managerMustProvide: mgrOk,
  };
}

/**
 * Жёсткая привязка всего ответа к корпусу: списки + свободные поля только с проверяемыми цитатами из inputs.
 * Заказчик сверяет пакет с КД — лишнее из «типовой практики» не показываем.
 *
 * @param {Record<string, unknown>} parsed — сырой JSON модели
 * @param {string} corpus
 * @returns {ReturnType<typeof normalizeAnalysis>}
 */
function applyStrictCorpusGrounding(parsed, corpus) {
  let structured = normalizeAnalysis(parsed);

  if (!isAnalyzeGroundingStrict()) {
    return {
      ...structured,
      lenaCanPrepare: structured.lenaCanPrepare.map(({ name, basis }) => ({ name, basis })),
      managerMustProvide: structured.managerMustProvide.map(({ name, reason, criteria }) => ({
        name,
        reason,
        criteria,
      })),
    };
  }

  const c = corpus.trim();
  if (!c) {
    return {
      tenderTitle: null,
      sumOrBudget: null,
      submissionOverview: null,
      submissionMethod: null,
      submissionDeadline: null,
      lenaCanPrepare: [],
      managerMustProvide: [],
    };
  }

  structured = keepOnlyCorpusGrounded(structured, c);

  const ttEv = typeof parsed.tenderTitleEvidence === "string" ? parsed.tenderTitleEvidence.trim() : "";
  if (structured.tenderTitle && !evidenceAppearsInCorpus(ttEv, c)) {
    structured = { ...structured, tenderTitle: null };
  }

  const sbEv = typeof parsed.sumOrBudgetEvidence === "string" ? parsed.sumOrBudgetEvidence.trim() : "";
  if (structured.sumOrBudget && !evidenceAppearsInCorpus(sbEv, c)) {
    structured = { ...structured, sumOrBudget: null };
  }

  /** @type {string[]} */
  const subQuotes = [];
  const rawSq = parsed.submissionOverviewQuotes ?? parsed.submissionEvidenceQuotes;
  if (Array.isArray(rawSq)) {
    for (const x of rawSq) {
      if (typeof x === "string" && collapseWs(x).length >= 14) subQuotes.push(collapseWs(x));
    }
  }
  const subOk = subQuotes.some((q) => evidenceAppearsInCorpus(q, c));
  if (structured.submissionOverview && !subOk) {
    structured = { ...structured, submissionOverview: null };
  }

  const smEv =
    typeof parsed.submissionMethodEvidence === "string" ? parsed.submissionMethodEvidence.trim() : "";
  if (structured.submissionMethod && !evidenceAppearsInCorpus(smEv, c)) {
    structured = { ...structured, submissionMethod: null };
  }

  const sdEv =
    typeof parsed.submissionDeadlineEvidence === "string" ? parsed.submissionDeadlineEvidence.trim() : "";
  if (structured.submissionDeadline && !evidenceAppearsInCorpus(sdEv, c)) {
    structured = { ...structured, submissionDeadline: null };
  }

  return structured;
}

/**
 * Подстановка суммы/дедлайна с карточки IceTrade, если в КД в inputs их не удалось выделить с цитатой.
 * @param {ReturnType<typeof normalizeAnalysis>} structured
 * @param {unknown} snap
 */
function applySnapshotFieldFallbacks(structured, snap) {
  const out = { ...structured };
  if (!String(out.sumOrBudget ?? "").trim()) {
    const h = snapshotProcedureBudgetHint(snap);
    if (h) out.sumOrBudget = h;
  }
  if (!String(out.submissionDeadline ?? "").trim()) {
    const d = snapshotBidsDeadlineHint(snap);
    if (d) out.submissionDeadline = d;
  }
  return out;
}

function buildAnalysisMarkdown(viewId, structured, notParsedFiles, ragUsed, usedParsedPipeline) {
  const lines = [
    `# IceTrade · анализ комплекта · ${viewId}`,
    "",
    `- UTC: ${new Date().toISOString()}`,
    `- RAG: ${ragUsed ? "да (фрагменты в промпт)" : "нет"}`,
    `- Корпус для модели: ${usedParsedPipeline ? "полный распарсенный текст (**tender-pipeline-state**)" : "укороченные фрагменты из файлов **inputs**"}`,
    "",
    "> **Источник требований:** только текст из **inputs** ниже (в т.ч. блок **«Данные карточки IceTrade»** из \`icetrade-import-snapshot.json\` и **распарсенный** текст вложений). Без додумываний; не упомянуто — не выводится.",
    "> **Участник:** для наших организаций (**ГС Ритейл**, **Финсельват**) считаем **резидентом РБ**; пункты требований **только для нерезидентов** в отчёт и матрицу **не включаем**.",
    "",
    "## Наименование / предмет",
    structured.tenderTitle || "_(не выделено автоматически)_",
    "",
    "## Сумма / начальная (макс.) цена / бюджет",
    structured.sumOrBudget || "_(не выделено — проверьте в ТЗ/извещении)_",
    "",
    "## Способ подачи (канал)",
    structured.submissionMethod || "—",
    "",
    "## Дедлайн (окончание приёма заявок)",
    structured.submissionDeadline || "—",
    "",
    "## Перечень к подаче (кратко)",
    structured.submissionOverview || "—",
    "",
    "## Матрица требований (строки только с цитатой из текста)",
    formatAnalysisMatrixBullets(structured),
    "",
    "## Файлы без извлечённого текста (PDF/DOC и т.п. — нужен parserit / ручной разбор)",
    notParsedFiles.length ? notParsedFiles.map((n) => `- ${n}`).join("\n") : "- нет",
    "",
  ];
  return lines.join("\n");
}

/**
 * Форматирование для Telegram после analyzeTenderAfterBootstrap.
 * @param {Awaited<ReturnType<typeof analyzeTenderAfterBootstrap>>} r
 */
export function formatIceTradeAnalysisForTelegram(r) {
  if (!r.ok) {
    return `**Анализ:** не выполнен — ${r.error ?? "ошибка"}`;
  }
  if ("insufficientInputText" in r && r.insufficientInputText) {
    const min = r.minInputCharsRequired ?? 120;
    const got = r.inputTextChars ?? 0;
    const fc = r.inputsFileCount ?? 0;
    const rootL = "tenderRootWebViewLink" in r ? r.tenderRootWebViewLink : undefined;
    const inL = "inputsFolderWebViewLink" in r ? r.inputsFolderWebViewLink : undefined;
    const lines = [
      "---",
      "**Анализ по этой закупке не выполнялся**",
      "",
      ...(rootL ? [`**Папка тендера (Google Drive):** ${rootL}`] : []),
      ...(inL ? [`**Документы заказчика (inputs):** ${inL}`] : []),
      ...(rootL || inL ? [""] : []),
      `В **inputs** мало **распознанного текста** из документов заказчика (сейчас **~${got}** знаков, нужно **≥${min}** — обычно Google Docs/Sheets или txt/md/csv; PDF/DOC без извлечения не учитываются).`,
    ];
    if (fc > 0) {
      lines.push("", `Файлов в inputs: **${fc}**`);
      if (r.notParsedFiles.length) {
        lines.push(
          `Без авто-текста: ${r.notParsedFiles.slice(0, 10).join(", ")}${r.notParsedFiles.length > 10 ? "…" : ""}`,
        );
      }
    } else {
      lines.push(
        "",
        "Папка **inputs** пустая: IceTrade мог не отдать страницу (**fetch failed**), отдать **укороченный HTML**, или ссылки на файлы видны только после полного рендера в браузере. **Положите комплект вручную** (после настройки Drive для SA — см. ниже).",
      );
    }
    lines.push(
      "",
      "_Раньше модель могла выдать «типовые формы» без ваших файлов — это не надёжно; такой вывод теперь **не показывается**._",
    );
    return lines.join("\n").trim();
  }
  const { structured, notParsedFiles, ragUsed } = r;
  const rootL = "tenderRootWebViewLink" in r ? r.tenderRootWebViewLink : undefined;
  const inL = "inputsFolderWebViewLink" in r ? r.inputsFolderWebViewLink : undefined;
  const fromPipeline =
    "usedParsedPipeline" in r && r.usedParsedPipeline ? " **(корпус после парсинга inputs)**" : "";
  const ph = "pricingHints" in r && r.pricingHints ? r.pricingHints : null;
  /** @type {string | undefined} */
  let pricingLine;
  if (ph) {
    if (ph.absurdStatedPrice) {
      pricingLine =
        "**Цена для КП:** в тексте встречается подозрительная сумма/заглушка — **только через менеджера** (сумма и НДС).";
    } else if (ph.reductionProcedure) {
      pricingLine =
        "**Цена для КП:** по тексту есть **процедура снижения** — в черновике укажи **только стартовую цену** из документов заказчика (без самовольных скидок).";
    } else {
      pricingLine =
        "**Цена для КП:** процедура снижения **не выявлена** — **запроси у менеджера цену** и **НДС (с/без)** по закупке, не придумывай сумму.";
    }
  }
  const prepLink =
    "preparationPromptFile" in r &&
    r.preparationPromptFile &&
    typeof /** @type {{ webViewLink?: string }} */ (r.preparationPromptFile).webViewLink === "string"
      ? /** @type {{ webViewLink?: string }} */ (r.preparationPromptFile).webViewLink
      : undefined;
  const lines = [
    "---",
    "**Результат разбора комплекта**",
    "",
    `_Источник: только текст из **inputs** + снимок карточки IceTrade (если он в inputs). Пункты матрицы без дословной опоры в этом тексте отброшены._${fromPipeline}`,
    "",
    ...(rootL ? [`**Папка тендера (Google Drive):** ${rootL}`] : []),
    ...(inL ? [`**Документы заказчика (inputs):** ${inL}`] : []),
    ...(rootL || inL ? [""] : []),
    ...(pricingLine ? [pricingLine, ""] : []),
    "**Компания для черновика КП:** выбрать **ГС Ритейл** или **Финсельват** (кнопки ниже), затем **«Сформировать КП»** или **/tenderkp**.",
    prepLink
      ? `**Промпт для модуля Preparation:** **\`${PREPARATION_PROMPT_FILENAME}\`** в **notes** — ${prepLink}`
      : "**Промпт для модуля Preparation:** не удалось записать файл в **notes** (см. ошибку ниже).",
    "",
    "**Дальше:** **«Сформировать КП»** или **/tenderkp** подставляют промпт и корпус; **ссылка на КП** — в следующих сообщениях после генерации.",
    "",
    `**Наименование:** ${structured.tenderTitle || "— (уточните по документам)"}`,
    `**Сумма / бюджет:** ${structured.sumOrBudget || "— (уточните в извещении/ТЗ)"}`,
    "",
    `**Способ подачи:** ${structured.submissionMethod || "—"}`,
    `**Дедлайн (окончание приёма):** ${structured.submissionDeadline || "—"}`,
    "",
    structured.submissionOverview
      ? `**К подаче (суть):** ${structured.submissionOverview}`
      : "",
    "",
    "**Матрица требований** (строки только с дословной цитатой во входном тексте):",
    formatAnalysisMatrixBullets(structured),
    "",
    notParsedFiles.length
      ? `**Без авто-текста (нужен разбор):** ${notParsedFiles.slice(0, 12).join(", ")}${notParsedFiles.length > 12 ? "…" : ""}`
      : "",
    "noteUploadError" in r && r.noteUploadError
      ? (() => {
          const msg = String(r.noteUploadError).slice(0, 600);
          const quotaHint =
            /storage quota|storageQuota|Service Accounts do not have storage/i.test(msg)
              ? "\n_Подсказка: перенесите корень Лены на **общий диск (Shared drive)** и добавьте сервисный аккаунт участником — см. docs/GOOGLE_DRIVE.md § «Общие диски»._"
              : "";
          return `\n**Заметка на Drive не записана:** ${msg}${quotaHint}`;
        })()
      : "",
    "preparationPromptUploadError" in r && r.preparationPromptUploadError
      ? `\n**Файл Preparation не записан:** ${String(r.preparationPromptUploadError).slice(0, 600)}`
      : "",
    ragUsed
      ? "\n_В промпт подмешан архив RAG (**LENA_ICETRADE_ANALYZE_USE_RAG**); строки матрицы всё равно только из текста inputs._"
      : "\n_Архив RAG в этот разбор **не** подмешивался — только **inputs** и снимок карточки. Для поиска по архиву в чате: **/archivesearch** (нужен **LENA_RAG_INDEX_DIR**)._",
  ].filter(Boolean);
  return lines.join("\n").trim();
}

/**
 * После bootstrap: читает inputs, тянет фрагменты RAG, зовёт LLM, кладёт отчёт в notes.
 * @param {string} userRootId
 * @param {string} tenderId
 * @param {{ flat?: boolean; year?: string }} [opts]
 */
export async function analyzeTenderAfterBootstrap(userRootId, tenderId, opts = {}) {
  assertCredentialsFile();
  if (!isLlmConfigured()) {
    return {
      ok: false,
      error: "Нужен LENA_OPENAI_API_KEY или OPENAI_API_KEY для анализа комплекта.",
    };
  }

  const maxFiles =
    Number.parseInt(process.env.LENA_ICETRADE_ANALYZE_MAX_FILES?.trim() ?? "35", 10) || 35;
  const maxCorpus =
    Number.parseInt(process.env.LENA_ICETRADE_ANALYZE_MAX_CORPUS?.trim() ?? "42000", 10) || 42_000;
  const pipelineMaxCorpus =
    Number.parseInt(process.env.LENA_ICETRADE_ANALYZE_PIPELINE_MAX_CORPUS?.trim() ?? "120000", 10) ||
    120_000;
  const pipelineMaxFiles =
    Number.parseInt(process.env.LENA_ICETRADE_ANALYZE_PIPELINE_MAX_FILES?.trim() ?? "60", 10) || 60;

  const minInput =
    Number.parseInt(process.env.LENA_ICETRADE_ANALYZE_MIN_INPUT_CHARS?.trim() ?? "120", 10) || 120;

  const { tender } = await ensureTenderTree(userRootId, tenderId, opts);
  const inputsId = tender.inputsId;
  const notesId = tender.notesId;

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

  const files = await listChildren(inputsId);

  const pipelineCorpus = await buildParsedInputsCorpus(userRootId, tenderId, opts, {
    maxFiles: pipelineMaxFiles,
    maxTotalChars: pipelineMaxCorpus,
  });

  /** @type {string[]} */
  let notParsedFiles = [];
  /** @type {string[]} */
  const corpusParts = [];
  let usedParsedPipeline = false;
  /** @type {string} */
  let corpus = "";

  if (pipelineCorpus.usedPipeline && pipelineCorpus.inputTextChars >= minInput) {
    corpus = pipelineCorpus.corpus.trim();
    if (corpus.length > pipelineMaxCorpus) {
      corpus = `${corpus.slice(0, pipelineMaxCorpus)}\n\n…[усечено]`;
    }
    notParsedFiles = [...pipelineCorpus.notParsedFiles];
    usedParsedPipeline = true;
  } else {
    const tmpRoot = await mkdtemp(join(tmpdir(), "lena-analyze-"));
    try {
      let n = 0;
      for (const f of files) {
        if (n >= maxFiles) break;
        const id = String(f.id ?? "");
        const name = String(f.name ?? "file");
        if (!id) continue;
        const mime = typeof f.mimeType === "string" ? f.mimeType : "";
        if (mime === "application/vnd.google-apps.folder") continue;

        n += 1;
        const meta = await getMetadata(id).catch(() => null);
        const mimeType = meta && typeof meta.mimeType === "string" ? meta.mimeType : mime;
        const snip = await extractTextSnippet(id, name, mimeType, tmpRoot);
        if (snip && snip.trim().length > 40) {
          corpusParts.push(`### Файл: ${name}\n${snip.trim()}`);
        } else {
          notParsedFiles.push(name);
        }
      }
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }

    corpus = corpusParts.join("\n\n").trim();
    if (corpus.length > maxCorpus) corpus = `${corpus.slice(0, maxCorpus)}\n\n…[усечено]`;
  }

  const inputTextChars = corpus.replace(/\s+/g, " ").trim().length;

  let inputsFileCount = 0;
  for (const f of files) {
    const m = typeof f.mimeType === "string" ? f.mimeType : "";
    if (m === "application/vnd.google-apps.folder") continue;
    if (!String(f.id ?? "")) continue;
    inputsFileCount += 1;
  }

  if (inputTextChars < minInput) {
    return {
      ok: true,
      insufficientInputText: true,
      minInputCharsRequired: minInput,
      inputTextChars,
      inputsFileCount,
      notParsedFiles,
      ragUsed: false,
      tenderNotesFolderId: notesId,
      tenderRootWebViewLink,
      inputsFolderWebViewLink,
    };
  }

  /** @type {string} */
  let ragBlock = "";
  let ragUsed = false;
  const ragDir = resolvedRagIndexDir();
  if (isIcetradeAnalyzeRagEnabled() && ragDir && (await ragDirReady(ragDir))) {
    try {
      const { hits } = await runQuery(
        ragDir,
        "перечень документов заявки справка банка референс лист квалификация коммерческое предложение приложения к заявке",
        { topK: 6, stripEmbedding: true },
      );
      ragBlock = hits
        .map((h) => String(/** @type {{ text?: string }} */ (h).text ?? "").trim())
        .filter(Boolean)
        .join("\n---\n")
        .slice(0, 6500);
      ragUsed = ragBlock.length > 20;
    } catch {
      ragBlock = "";
    }
  }

  const corpusBlockTitle = usedParsedPipeline
    ? "### Текст документов заказчика (полный распарсенный корпус по tender-pipeline-state)"
    : "### Фрагменты из inputs";

  const system = [
    "Ты «Лена» — специалист по тендерам (IceTrade). Отвечай только JSON без Markdown и без текста вне JSON.",
    "Источник истины — **один** блок пользователя: либо «### Текст документов заказчика (полный распарсенный корпус по tender-pipeline-state)», либо «### Фрагменты из inputs». В обоих случаях там только материал из папки **inputs** заказчика (в т.ч. снимок карточки IceTrade, если он лежит в inputs). В полном корпусе — выгрузка по manifest/state после парсинга; во фрагментах — укороченные выдержки из тех же файлов.",
    "Жёсткий запрет: не дополнять типовыми требованиями РБ, «обычно нужно», здравым смыслом или блоком RAG. Не перечисляй справку банка, выписку ЕГР/торгреестра, референс-лист, учредительные, доверенности и т.п., если в блоке с текстом заказчика этого **нет явно** (формулировка или перечень). Заказчик сверяет пакет со своей КД — лишнее = вред.",
    "Правила полей:",
    "- tenderTitle — только если кратко выводится из текста фрагментов; иначе null. Обязательно tenderTitleEvidence: дословная подстрока из того же блока (15+ символов), подтверждающая наименование; иначе tenderTitle=null.",
    "- sumOrBudget — одна строка только при явных цифрах/формулировке бюджета в фрагментах; иначе null. Обязательно sumOrBudgetEvidence: дословная citation из блока (15+ символов); иначе sumOrBudget=null.",
    "- submissionOverview — 1–4 предложения только как пересказ того, что **прямо сказано** в блоке о составе заявки / подаче; иначе null. Обязательно submissionOverviewQuotes: массив из 1–4 **дословных** цитат из блока (каждая 15+ символов), на которых основан пересказ; если не можешь набрать цитаты — submissionOverview=null и массив пустой.",
    "- submissionMethod — одна строка: **способ подачи** заявки/документов (площадка, лично, ЭП, адрес и т.д.) **только** если явно в блоке; иначе null. submissionMethodEvidence — дословная цитата 15+ символов; иначе submissionMethod=null.",
    "- submissionDeadline — одна строка: **дата/время окончания приёма** заявок (дедлайн), как в блоке; иначе null. submissionDeadlineEvidence — дословная цитата 15+ символов; иначе submissionDeadline=null.",
    "- lenaCanPrepare[]: только документ/действие, явно следующие из текста заказчика или карточки. У каждого элемента: name, basis (кратко откуда по смыслу), evidence — дословная цитата 15+ символов из блока. Нет цитаты — не включай элемент. Никаких «аналог из RAG».",
    "- managerMustProvide[]: только если участнику/менеджеру **прямо** требуется внешний документ или данные по тексту блока. evidence — дословная цитата 15+ символов. criteria — только то, что дословно или почти дословно есть в блоке; иначе null (не заполняй «типично для РБ»).",
    "- **Резидент РБ:** обе наши организации (**ГС Ритейл** и **Финсельват**) — **резиденты Республики Беларусь**. **Не включай** в lenaCanPrepare и managerMustProvide требования, которые по тексту относятся **исключительно** к нерезидентам / иностранным участникам / особым правилам для нерезидентов — для матрицы их **пропускай**. Если в КД даны ветки «резидент / нерезидент», отражай в матрице **только ветку резидента**.",
    "Если фрагментов мало — пустые массивы и nullы нормальны.",
    "Форма ответа (ключи строго):",
    '{"tenderTitle":string|null,"tenderTitleEvidence":string,"sumOrBudget":string|null,"sumOrBudgetEvidence":string,"submissionOverview":string|null,"submissionOverviewQuotes":string[],"submissionMethod":string|null,"submissionMethodEvidence":string,"submissionDeadline":string|null,"submissionDeadlineEvidence":string,"lenaCanPrepare":[{"name":string,"basis":string,"evidence":string}],"managerMustProvide":[{"name":string,"reason":string,"criteria":string|null,"evidence":string}]}',
  ].join(" ");

  const userContent = [
    `viewId/tender_id на площадке: ${tenderId}`,
    "",
    corpusBlockTitle,
    corpus.length ? corpus : "_(нет извлечённого текста — возможно только PDF/DOC; списки будут общими)_",
    "",
    isIcetradeAnalyzeRagEnabled()
      ? `### Фрагменты архива RAG (не источник требований; нельзя добавлять пункты матрицы только из этого блока)\n${ragUsed ? ragBlock : "_(нет)_"}`
      : "### Фрагменты архива RAG\n_(отключено — LENA_ICETRADE_ANALYZE_USE_RAG=1 для подмешивания; требования только из inputs)_",
  ].join("\n");

  let rawLlm = "";
  let structured = {
    tenderTitle: null,
    sumOrBudget: null,
    submissionOverview: null,
    submissionMethod: null,
    submissionDeadline: null,
    lenaCanPrepare: /** @type {{ name: string; basis: string }[]} */ ([]),
    managerMustProvide: /** @type {{ name: string; reason: string; criteria: string }[]} */ ([]),
  };

  try {
    rawLlm = await chatCompletion(
      [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      { temperature: 0.12, max_tokens: 3500 },
    );
    const parsed = parseLlmJson(rawLlm);
    structured = applyStrictCorpusGrounding(parsed, corpus);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      rawLlm: rawLlm.slice(0, 1500),
      notParsedFiles,
      ragUsed,
      tenderRootWebViewLink,
      inputsFolderWebViewLink,
    };
  }

  const generatedAtIso = new Date().toISOString();
  const pricingHints = {
    reductionProcedure: corpusMentionsPriceReductionProcedure(corpus),
    absurdStatedPrice: corpusSuggestsAbsurdStatedPrice(corpus),
  };

  const preparationPrompt = buildPreparationPromptMarkdown({
    tenderId,
    structured,
    corpus,
    generatedAtIso,
  });

  const md =
    buildAnalysisMarkdown(tenderId, structured, notParsedFiles, ragUsed, usedParsedPipeline) +
    `\n\n---\n\n## Модуль Preparation\n\nВ папке **notes** тендера обновляется файл **\`${PREPARATION_PROMPT_FILENAME}\`** — **входной промпт** для генерации КП. **«Сформировать КП»** под сообщением (или **/tenderkp**) подставляет его в Preparation вместе с корпусом; черновик — в **drafts** (ссылка в Telegram после генерации).\n`;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const noteName = `icetrade-analysis-${tenderId}-${stamp}.md`;
  const tmp = await mkdtemp(join(tmpdir(), "lena-anote-"));
  const notePath = join(tmp, noteName);
  let noteUpload = null;
  /** @type {string | undefined} */
  let noteUploadError;
  /** @type {Awaited<ReturnType<typeof replacePreparationPromptFile>> | null} */
  let preparationPromptFile = null;
  /** @type {string | undefined} */
  let preparationPromptUploadError;
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(notePath, md, "utf8");
    try {
      noteUpload = await uploadFile(notesId, notePath, noteName);
    } catch (ue) {
      noteUploadError = ue instanceof Error ? ue.message : String(ue);
    }
    try {
      preparationPromptFile = await replacePreparationPromptFile(notesId, preparationPrompt);
    } catch (pe) {
      preparationPromptUploadError = pe instanceof Error ? pe.message : String(pe);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  return {
    ok: true,
    structured,
    notParsedFiles,
    ragUsed,
    usedParsedPipeline,
    pricingHints,
    preparationPrompt,
    preparationPromptFile,
    preparationPromptUploadError,
    noteFile: noteUpload,
    noteUploadError,
    tenderNotesFolderId: notesId,
    tenderRootWebViewLink,
    inputsFolderWebViewLink,
  };
}
