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
  applyCanonicalNamesToStructured,
  buildRequiredDocumentsList,
  formatDocumentCompositionStep1Telegram,
  isExcludedParticipantRequirement,
  isNonResidentOnlyRequirement,
  shouldIncludeChecklistItem,
  stripRequirementParentheticals,
  relocateQualificationMislabels,
  dedupeQualificationRequirements,
  formatQualificationRequirementTelegramBlock,
} from "../analysis/documentChecklist.js";
import { computeBankReferenceMaxDateIso } from "../analysis/verifyDocumentAvailability.js";
import { computeLastReportingQuarterHint } from "../analysis/identifyUploadedDocuments.js";
import { checklistDebug714167, checklistDebug714167UploadNotes } from "../debug/checklistDebug714167.js";
import {
  canonicalTitlesForAnalysisPrompt,
  normalizeToCanonicalDocument,
} from "../analysis/canonicalDocumentTypes.js";
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
  /** @type {{ summary: string; evidence: string; criteriaNumbers?: string }[]} */
  const qualificationRequirements = [];

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

  const q =
    typeof o.qualificationRequirements === "object" && o.qualificationRequirements !== null
      ? o.qualificationRequirements
      : [];
  if (Array.isArray(q)) {
    for (const x of q) {
      if (!x || typeof x !== "object") continue;
      const summary =
        typeof /** @type {{ summary?: string }} */ (x).summary === "string" ? x.summary.trim() : "";
      const evidence =
        typeof /** @type {{ evidence?: string }} */ (x).evidence === "string" ? x.evidence.trim() : "";
      const criteriaNumbers =
        typeof /** @type {{ criteriaNumbers?: string }} */ (x).criteriaNumbers === "string"
          ? x.criteriaNumbers.trim()
          : "";
      /** @type {string[]} */
      const confirmationDocuments = [];
      const confRaw = /** @type {{ confirmationDocuments?: unknown }} */ (x).confirmationDocuments;
      if (Array.isArray(confRaw)) {
        for (const d of confRaw) {
          if (typeof d === "string" && d.trim().length > 3) confirmationDocuments.push(d.trim());
        }
      }
      if (summary) {
        qualificationRequirements.push({
          summary,
          evidence,
          criteriaNumbers: criteriaNumbers || undefined,
          confirmationDocuments: confirmationDocuments.length ? confirmationDocuments : undefined,
        });
      }
    }
  }

  /** @type {{ summary: string; evidence: string }[]} */
  const cpCompositionRequirements = [];
  const cpRaw =
    typeof o.cpCompositionRequirements === "object" && o.cpCompositionRequirements !== null
      ? o.cpCompositionRequirements
      : [];
  if (Array.isArray(cpRaw)) {
    for (const x of cpRaw) {
      if (!x || typeof x !== "object") continue;
      const summary =
        typeof /** @type {{ summary?: string }} */ (x).summary === "string" ? x.summary.trim() : "";
      const evidence =
        typeof /** @type {{ evidence?: string }} */ (x).evidence === "string" ? x.evidence.trim() : "";
      if (summary) cpCompositionRequirements.push({ summary, evidence });
    }
  }

  /** @type {{ summary: string; evidence: string; computedDeadlineHint?: string } | null} */
  let bankReferenceDateRule = null;
  const br = o.bankReferenceDateRule;
  if (br && typeof br === "object") {
    const summary =
      typeof /** @type {{ summary?: string }} */ (br).summary === "string" ? br.summary.trim() : "";
    const evidence =
      typeof /** @type {{ evidence?: string }} */ (br).evidence === "string" ? br.evidence.trim() : "";
    const computedDeadlineHint =
      typeof /** @type {{ computedDeadlineHint?: string }} */ (br).computedDeadlineHint === "string"
        ? br.computedDeadlineHint.trim()
        : "";
    if (summary) {
      bankReferenceDateRule = {
        summary,
        evidence,
        computedDeadlineHint: computedDeadlineHint || undefined,
      };
    }
  }

  /** @type {{ summary: string; evidence: string; computedPeriodHint?: string } | null} */
  let balanceSheetPeriodRule = null;
  const bs = o.balanceSheetPeriodRule;
  if (bs && typeof bs === "object") {
    const summary =
      typeof /** @type {{ summary?: string }} */ (bs).summary === "string" ? bs.summary.trim() : "";
    const evidence =
      typeof /** @type {{ evidence?: string }} */ (bs).evidence === "string" ? bs.evidence.trim() : "";
    const computedPeriodHint =
      typeof /** @type {{ computedPeriodHint?: string }} */ (bs).computedPeriodHint === "string"
        ? bs.computedPeriodHint.trim()
        : "";
    if (summary) {
      balanceSheetPeriodRule = { summary, evidence, computedPeriodHint: computedPeriodHint || undefined };
    }
  }

  /** @type {{ summary: string; evidence: string; computedPeriodHint?: string } | null} */
  let incomeStatementPeriodRule = null;
  const isr = o.incomeStatementPeriodRule;
  if (isr && typeof isr === "object") {
    const summary =
      typeof /** @type {{ summary?: string }} */ (isr).summary === "string" ? isr.summary.trim() : "";
    const evidence =
      typeof /** @type {{ evidence?: string }} */ (isr).evidence === "string" ? isr.evidence.trim() : "";
    const computedPeriodHint =
      typeof /** @type {{ computedPeriodHint?: string }} */ (isr).computedPeriodHint === "string"
        ? isr.computedPeriodHint.trim()
        : "";
    if (summary) {
      incomeStatementPeriodRule = {
        summary,
        evidence,
        computedPeriodHint: computedPeriodHint || undefined,
      };
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
    qualificationRequirements,
    cpCompositionRequirements,
    bankReferenceDateRule,
    balanceSheetPeriodRule,
    incomeStatementPeriodRule,
  };
}

/**
 * @param {{ summary: string; evidence?: string; criteriaNumbers?: string }} x
 * @param {string} corpus
 */
function passesQualificationGrounding(x, corpus) {
  if (!x.summary?.trim()) return false;
  const strict = isAnalyzeGroundingStrict();
  if (!strict) return Boolean(x.evidence?.trim());
  if (!corpus.trim()) return false;
  return Boolean(x.evidence && evidenceAppearsInCorpus(x.evidence, corpus));
}

/**
 * @param {{ summary: string; evidence?: string; criteriaNumbers?: string }[]} items
 * @param {string} corpus
 */
function filterQualificationRequirements(items, corpus) {
  const filtered = items
    .filter((x) => passesQualificationGrounding(x, corpus))
    .map(({ summary, evidence, criteriaNumbers, confirmationDocuments }) => ({
      summary: summary.trim(),
      evidence: String(evidence ?? "").trim(),
      criteriaNumbers: criteriaNumbers?.trim() || undefined,
      confirmationDocuments: Array.isArray(confirmationDocuments)
        ? confirmationDocuments.map((d) => String(d).trim()).filter((d) => d.length > 3)
        : undefined,
    }));
  return dedupeQualificationRequirements(filtered);
}

/**
 * @param {{ summary: string; evidence?: string }} x
 * @param {string} corpus
 */
function passesSummaryEvidenceGrounding(x, corpus) {
  if (!x.summary?.trim()) return false;
  const strict = isAnalyzeGroundingStrict();
  if (!strict) return Boolean(x.evidence?.trim());
  if (!corpus.trim()) return false;
  return Boolean(x.evidence && evidenceAppearsInCorpus(x.evidence, corpus));
}

/**
 * @param {{ summary: string; evidence?: string }[]} items
 * @param {string} corpus
 */
function filterSummaryEvidenceList(items, corpus) {
  return items
    .filter((x) => passesSummaryEvidenceGrounding(x, corpus))
    .map(({ summary, evidence }) => ({
      summary: summary.trim(),
      evidence: String(evidence ?? "").trim(),
    }));
}

/**
 * @param {{ summary: string; evidence?: string; computedDeadlineHint?: string } | null} rule
 * @param {string} corpus
 */
function filterOrgPeriodRule(rule, corpus) {
  if (!rule?.summary?.trim()) return null;
  if (!passesSummaryEvidenceGrounding(rule, corpus)) return null;
  return {
    summary: rule.summary.trim(),
    evidence: String(rule.evidence ?? "").trim(),
    computedDeadlineHint: rule.computedDeadlineHint?.trim() || undefined,
    computedPeriodHint: rule.computedPeriodHint?.trim() || undefined,
  };
}

/**
 * @param {ReturnType<typeof normalizeAnalysis>} structured
 */
function enrichOrgDocPeriodFields(structured) {
  structured = relocateQualificationMislabels(structured);
  let bankReferenceDateRule = structured.bankReferenceDateRule;
  let balanceSheetPeriodRule = structured.balanceSheetPeriodRule ?? null;
  let incomeStatementPeriodRule = structured.incomeStatementPeriodRule ?? null;

  if (!bankReferenceDateRule) {
    const item = structured.managerMustProvide.find(
      (x) => normalizeToCanonicalDocument(stripRequirementParentheticals(x.name) || x.name).id === "bank_reference",
    );
    if (item) {
      const summary =
        (item.criteria && item.criteria !== "—" ? item.criteria : item.reason) || item.name;
      bankReferenceDateRule = { summary, evidence: item.evidence || summary };
    }
  }
  if (!balanceSheetPeriodRule) {
    const item = structured.managerMustProvide.find(
      (x) => normalizeToCanonicalDocument(stripRequirementParentheticals(x.name) || x.name).id === "balance_sheet",
    );
    if (item) {
      const summary =
        (item.criteria && item.criteria !== "—" ? item.criteria : item.reason) || item.name;
      balanceSheetPeriodRule = { summary, evidence: item.evidence || summary };
    }
  }
  if (!incomeStatementPeriodRule) {
    const item = structured.managerMustProvide.find(
      (x) =>
        normalizeToCanonicalDocument(stripRequirementParentheticals(x.name) || x.name).id ===
        "income_statement",
    );
    if (item) {
      const summary =
        (item.criteria && item.criteria !== "—" ? item.criteria : item.reason) || item.name;
      incomeStatementPeriodRule = { summary, evidence: item.evidence || summary };
    }
  }

  if (bankReferenceDateRule && structured.submissionDeadline) {
    const max = computeBankReferenceMaxDateIso(structured.submissionDeadline);
    if (max) bankReferenceDateRule = { ...bankReferenceDateRule, computedDeadlineHint: max };
  }
  const periodHint = computeLastReportingQuarterHint(structured.submissionDeadline);
  if (balanceSheetPeriodRule && periodHint && !balanceSheetPeriodRule.computedPeriodHint) {
    balanceSheetPeriodRule = { ...balanceSheetPeriodRule, computedPeriodHint: periodHint };
  }
  if (incomeStatementPeriodRule && periodHint && !incomeStatementPeriodRule.computedPeriodHint) {
    incomeStatementPeriodRule = { ...incomeStatementPeriodRule, computedPeriodHint: periodHint };
  }

  return {
    ...structured,
    bankReferenceDateRule,
    balanceSheetPeriodRule,
    incomeStatementPeriodRule,
    cpCompositionRequirements: structured.cpCompositionRequirements ?? [],
  };
}

/**
 * @param {{ name: string; basis?: string; reason?: string; criteria?: string; evidence?: string }} x
 */
function passesChecklistEvidenceFilter(x) {
  const cleanName = stripRequirementParentheticals(x.name) || x.name;
  const n = normalizeToCanonicalDocument(cleanName);
  return shouldIncludeChecklistItem({ ...x, evidence: x.evidence }, n);
}

/**
 * Только пункты с цитатой из корпуса (фрагменты inputs: файлы + снимок карточки IceTrade).
 * @param {ReturnType<typeof normalizeAnalysis>} structured
 * @param {string} corpus
 */
function keepOnlyCorpusGrounded(structured, corpus) {
  const strict = isAnalyzeGroundingStrict();

  if (!strict || !corpus.trim()) {
    return enrichOrgDocPeriodFields({
      ...structured,
      qualificationRequirements: filterQualificationRequirements(
        structured.qualificationRequirements ?? [],
        corpus,
      ),
      cpCompositionRequirements: filterSummaryEvidenceList(
        structured.cpCompositionRequirements ?? [],
        corpus,
      ),
      bankReferenceDateRule: filterOrgPeriodRule(structured.bankReferenceDateRule, corpus),
      balanceSheetPeriodRule: filterOrgPeriodRule(structured.balanceSheetPeriodRule, corpus),
      incomeStatementPeriodRule: filterOrgPeriodRule(structured.incomeStatementPeriodRule, corpus),
      lenaCanPrepare: structured.lenaCanPrepare
        .filter((x) => !isExcludedParticipantRequirement(x))
        .filter((x) => passesChecklistEvidenceFilter(x))
        .map(({ name, basis, evidence }) => ({ name, basis, evidence })),
      managerMustProvide: structured.managerMustProvide
        .filter((x) => !isExcludedParticipantRequirement(x))
        .filter((x) => passesChecklistEvidenceFilter(x))
        .map(({ name, reason, criteria, evidence }) => ({
          name,
          reason,
          criteria,
          evidence,
        })),
    });
  }

  /** @type {{ name: string; basis: string; evidence?: string }[]} */
  const lenaOk = [];
  for (const x of structured.lenaCanPrepare) {
    if (!evidenceAppearsInCorpus(x.evidence, corpus)) continue;
    if (!passesChecklistEvidenceFilter(x)) continue;
    lenaOk.push({ name: x.name, basis: x.basis, evidence: x.evidence });
  }

  /** @type {{ name: string; reason: string; criteria: string; evidence?: string }[]} */
  const mgrOk = [];
  for (const x of structured.managerMustProvide) {
    if (!evidenceAppearsInCorpus(x.evidence, corpus)) continue;
    if (!passesChecklistEvidenceFilter(x)) continue;
    let criteria = x.criteria;
    if (criteria && !evidenceAppearsInCorpus(criteria, corpus) && criteria !== "—") {
      const critTrim = collapseWs(criteria);
      if (critTrim.length >= 14 && !evidenceAppearsInCorpus(critTrim, corpus)) criteria = null;
    }
    mgrOk.push({
      name: x.name,
      reason: x.reason,
      criteria: criteria || "—",
      evidence: x.evidence,
    });
  }

  return enrichOrgDocPeriodFields({
    ...structured,
    qualificationRequirements: filterQualificationRequirements(
      structured.qualificationRequirements ?? [],
      corpus,
    ),
    cpCompositionRequirements: filterSummaryEvidenceList(
      structured.cpCompositionRequirements ?? [],
      corpus,
    ),
    bankReferenceDateRule: filterOrgPeriodRule(structured.bankReferenceDateRule, corpus),
    balanceSheetPeriodRule: filterOrgPeriodRule(structured.balanceSheetPeriodRule, corpus),
    incomeStatementPeriodRule: filterOrgPeriodRule(structured.incomeStatementPeriodRule, corpus),
    lenaCanPrepare: lenaOk.filter((x) => !isExcludedParticipantRequirement(x)),
    managerMustProvide: mgrOk.filter((x) => !isExcludedParticipantRequirement(x)),
  });
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
    return keepOnlyCorpusGrounded(structured, corpus);
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
      qualificationRequirements: [],
      cpCompositionRequirements: [],
      bankReferenceDateRule: null,
      balanceSheetPeriodRule: null,
      incomeStatementPeriodRule: null,
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
    "## Требования к квалификации (саммари с цитатами)",
    ...(structured.qualificationRequirements?.length
      ? dedupeQualificationRequirements(structured.qualificationRequirements).map(
          (x) => formatQualificationRequirementTelegramBlock(x).replace(/^- /, ""),
        )
      : ["- _(в корпусе не выделен раздел квалификации с цитатой)_"]),
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
 * Краткий вывод для Telegram (legacy-имя; тот же формат, что после «Анализ документов»).
 * @param {Awaited<ReturnType<typeof analyzeTenderAfterBootstrap>>} r
 */
export function formatIceTradeAnalysisForTelegram(r) {
  if (!r.ok) {
    return `**Анализ:** не выполнен — ${r.error ?? "ошибка"}`;
  }
  if ("insufficientInputText" in r && r.insufficientInputText) {
    const min = r.minInputCharsRequired ?? 120;
    const got = r.inputTextChars ?? 0;
    const inL = "inputsFolderWebViewLink" in r ? r.inputsFolderWebViewLink : undefined;
    return [
      inL ? `**Документы заказчика:** ${inL}` : "",
      `Мало текста в inputs (~${got} знаков, нужно ≥${min}).`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  const inL = "inputsFolderWebViewLink" in r ? r.inputsFolderWebViewLink : undefined;
  const corpus = "corpus" in r && typeof r.corpus === "string" ? r.corpus : undefined;
  const requiredDocuments = buildRequiredDocumentsList(r.structured, { corpus });
  return formatDocumentCompositionStep1Telegram(r.structured, requiredDocuments, inL);
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
    `- lenaCanPrepare[]: только документ/действие, явно следующие из текста заказчика или карточки. Поле name — **максимально близко** к типовым названиям: ${canonicalTitlesForAnalysisPrompt()}. У каждого элемента: name, basis (кратко откуда по смыслу), evidence — дословная цитата 15+ символов из блока. Нет цитаты — не включай элемент. Никаких «аналог из RAG».`,
    `- managerMustProvide[]: только если участнику/менеджеру **прямо** требуется внешний документ или данные по тексту блока. Поле name — **максимально близко** к типовым названиям (см. выше). evidence — дословная цитата 15+ символов. criteria — только то, что дословно или почти дословно есть в блоке; иначе null (не заполняй «типично для РБ»).`,
    "- **Резидент РБ:** обе наши организации (**ГС Ритейл** и **Финсельват**) — **резиденты Республики Беларусь**. **Не включай** выписку из торгового реестра и иные документы **только для нерезидентов**. Если в КД даны ветки «резидент / нерезидент», отражай **только ветку резидента** — документы, **явно** указанные для резидентов (свидетельство о гос. регистрации и т.д.), с дословной цитатой из КД.",
    "- **Не производители:** обе организации — **не производители**. В КД с ветками «производитель / представитель» включай **только ветку представителя** (дилерское, агентское, комиссионное соглашение). **Не включай** справку ТПП и документы **только для производителей**.",
    "- **В составе КП, не отдельно:** «Условия оплаты» и «Гарантийные обязательства» **не выноси** отдельными пунктами чеклиста — они входят в коммерческое предложение (раздел о стоимости и условиях). Включай только если заказчик требует **отдельный самостоятельный документ** с таким названием (редко; с дословной цитатой).",
    "- **Референс-лист:** только при **явном** требовании отдельного документа «референс-лист» / «reference list» в КД. Не путать с критериями «аналогичный опыт» без отдельного документа. Поле **name** не может быть «Референс-лист», если в **evidence** нет слова «референс».",
    "- **Декларации соответствия:** только если **дословно** названы в КД или ТЗ. Не предполагай по фразе «документы по ТЗ» без конкретного названия. Поле **name** не может быть «Декларации соответствия», если в **evidence** нет формулировки «декларация … соответствия».",
    "- **Согласованность name и evidence:** **name** каждого элемента должен описывать **тот же** документ, что и цитата **evidence**; не подставляй типовое название, не совпадающее с текстом цитаты.",
    "- **Товары не из СНГ (Китай и др.):** если в п.3.2 КД есть ветка про сертификат о происхождении для государств, не являющихся участниками СНГ — включи «Сертификат о происхождении товара» в managerMustProvide (ветка **резидента РБ**: ТПП РБ или её УП; с дословной цитатой).",
    "- **П.3.2 КД:** разделы «Документы и сведения…» — **каждый нумерованный подпункт** = отдельный элемент чеклиста. П. «документы, указанные в ТЗ» — извлекай **конкретные** названия из текста ТЗ (декларации, таблица соответствия и т.д.), не оставляй абстрактной фразой. Заявление о согласии с условиями КД/проекта договора → lenaCanPrepare.",
    "- **qualificationRequirements[]** — **отдельно** от lenaCanPrepare/managerMustProvide: критерии **квалификации** (опыт, проекты, специалисты, суммы, сроки). **Один элемент массива = один критерий** (не объединяй опыт и кадры в один пункт). Ищи блоки «квалификационные требования», «подтверждение квалификации», «перечень документов… квалификации», нумерованные критерии с «должен иметь», «не менее», «предоставить копии». Поле **summary** — **сжатое** описание подтверждаемого критерия (1 предложение): сохрани **числа, «или/либо», валюту**; **без** перечня подтверждающих документов. Поле **evidence** — **полный** дословный текст критерия из КД (15+ символов), включая формулировку порога. Поле **confirmationDocuments** — массив строк: **чем подтверждается** критерий (каждый элемент — один вид документа/сведений, например «копии договоров», «акты выполненных работ», «дипломы о высшем образовании»). **criteriaNumbers** — ключевые цифры/пороги одной строкой или null. **Не используй** канонические name из списка типов документов. Критерии квалификации с договорами/актами/дипломами → сюда, а не в managerMustProvide как «Референс-лист». Пустой массив, если в корпусе нет раздела квалификации.",
    "- **Не дублируй квалификацию в managerMustProvide:** документы, которые **только** подтверждают квалификацию (копии договоров и актов по опыту, дипломы, резюме специалистов, выписки из трудовых книжек, проектная документация по кадрам) — **только** в qualificationRequirements[].confirmationDocuments; **не** включай их отдельными строками managerMustProvide, если они уже описаны в блоке квалификации.",
    "- **Техническое предложение:** включай **только** если в evidence есть дословно «техническое предложение» / «техпредложение». **Не** включай из-за «технического образования», «технического задания», «информационных технологий» или критериев квалификации.",
    "- **Предложение = коммерческое предложение (КП):** в КД заказчик может писать «**Предложение**», «**Предложение на поставку…**», «ценовое предложение», «требования к форме и содержанию **предложения** участника» — это **один** документ **«Коммерческое предложение»** (name в lenaCanPrepare). **Не** добавляй вторую строку «Предложение», если уже есть «Коммерческое предложение» или наоборот. **Не путай** с «техническим предложением» (отдельный тип только при дословной цитате). На шаге 1 Telegram блок **«Кроме того пакет должен содержать»** — все документы пакета **кроме** подтверждающих квалификацию; без дублей с qualificationRequirements[].confirmationDocuments.",
    "- **cpCompositionRequirements[]** — **отдельно**: разделы/приложения **коммерческого предложения**, которые заказчик **явно** требует в КД (структура КП, обязательные разделы, приложения к КП). Поле **summary** — что именно включить в КП; **evidence** — дословная цитата 15+ символов. **Не выдумывай** разделы, которых нет в корпусе. Пустой массив, если структура КП не детализирована.",
    "- **bankReferenceDateRule** — объект или null: правило **срока/даты** справки из банка из КД (например «не ранее 1-го числа месяца, предшествующего месяцу окончания приёма заявок»). Поля **summary** (кратко по-русски), **evidence** (цитата 15+ символов). **computedDeadlineHint** — null (вычислится позже).",
    "- **balanceSheetPeriodRule** — объект или null: правило **отчётного периода** бухгалтерского баланса (например «за последний отчётный квартал»). Поля **summary**, **evidence** (цитата 15+ символов). **computedPeriodHint** — null.",
    "- **incomeStatementPeriodRule** — объект или null: то же для **ОФР** / отчёта о финансовых результатах. Поля **summary**, **evidence**. **computedPeriodHint** — null.",
    "- **attachedFormHint** (опционально в lenaCanPrepare): имя файла из inputs, если КД ссылается на приложение-форму («форма заявки», «приложение N»); только если имя/файл есть в корпусе или списке файлов — не выдумывай.",
    "Если фрагментов мало — пустые массивы и nullы нормальны.",
    "Форма ответа (ключи строго):",
    '{"tenderTitle":string|null,"tenderTitleEvidence":string,"sumOrBudget":string|null,"sumOrBudgetEvidence":string,"submissionOverview":string|null,"submissionOverviewQuotes":string[],"submissionMethod":string|null,"submissionMethodEvidence":string,"submissionDeadline":string|null,"submissionDeadlineEvidence":string,"qualificationRequirements":[{"summary":string,"evidence":string,"criteriaNumbers":string|null,"confirmationDocuments":string[]}],"cpCompositionRequirements":[{"summary":string,"evidence":string}],"bankReferenceDateRule":{"summary":string,"evidence":string,"computedDeadlineHint":string|null}|null,"balanceSheetPeriodRule":{"summary":string,"evidence":string,"computedPeriodHint":string|null}|null,"incomeStatementPeriodRule":{"summary":string,"evidence":string,"computedPeriodHint":string|null}|null,"lenaCanPrepare":[{"name":string,"basis":string,"evidence":string,"attachedFormHint":string|null}],"managerMustProvide":[{"name":string,"reason":string,"criteria":string|null,"evidence":string}]}',
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
    qualificationRequirements: /** @type {{ summary: string; evidence: string; criteriaNumbers?: string }[]} */ ([]),
    cpCompositionRequirements: /** @type {{ summary: string; evidence: string }[]} */ ([]),
    bankReferenceDateRule: null,
    balanceSheetPeriodRule: null,
    incomeStatementPeriodRule: null,
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
    structured = applyCanonicalNamesToStructured(applyStrictCorpusGrounding(parsed, corpus));
    // #region agent log
    checklistDebug714167(
      "analyzeAfterBootstrap.js:afterGrounding",
      "structured matrix after grounding",
      {
        tenderId,
        corpusChars: corpus.length,
        llmMgrBefore: (Array.isArray(parsed.managerMustProvide) ? parsed.managerMustProvide : []).map(
          (x) => ({
            name: typeof x?.name === "string" ? x.name : "",
            ev: String(x?.evidence ?? "").slice(0, 60),
          }),
        ),
        mgrAfter: structured.managerMustProvide.map((x) => ({
          name: x.name,
          ev: String(x.evidence ?? "").slice(0, 60),
        })),
        lenaAfter: structured.lenaCanPrepare.map((x) => x.name),
      },
      "H2-H3",
    );
    // #endregion
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

  const requiredPreview = buildRequiredDocumentsList(structured, { corpus });
  await checklistDebug714167UploadNotes(notesId, {
    tenderId,
    corpusChars: corpus.length,
    usedParsedPipeline,
    notParsedFiles,
    qualificationCount: structured.qualificationRequirements?.length ?? 0,
    lenaNames: structured.lenaCanPrepare.map((x) => x.name),
    mgrNames: structured.managerMustProvide.map((x) => ({
      name: x.name,
      evidence: String(x.evidence ?? "").slice(0, 120),
    })),
    requiredIds: requiredPreview.map((d) => d.id),
    requiredTitles: requiredPreview.map((d) => d.title),
  });

  return {
    ok: true,
    structured,
    corpus,
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
