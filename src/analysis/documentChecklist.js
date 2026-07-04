import {
  CANONICAL_DOCUMENT_TYPES,
  normalizeToCanonicalDocument,
} from "./canonicalDocumentTypes.js";
import { ensureDocumentUploadTargets } from "./ensureDocumentUploadTargets.js";
import { listChildren } from "../drive/ops.js";
import { ensureTenderTree } from "../drive/workspace.js";
import {
  formatFormSourceTelegramHint,
  resolveDocumentFormSource,
} from "./resolveDocumentFormSource.js";
import {
  formatVerifyTelegramSuffix,
  isLenaPreparedChecklistItem,
  isVerifyStatusAlreadyHave,
  isVerifyStatusNeedsUpload,
  shouldShowInLenaPrepareBlock,
  verifyDocumentsForChecklist,
} from "./verifyDocumentAvailability.js";
import { ingestUploadedDocuments } from "./ingestUploadedDocuments.js";
import { syncSubmissionPackage, resolveSubmissionFolderLink } from "../drive/syncSubmissionPackage.js";
import { checklistDebug714167 } from "../debug/checklistDebug714167.js";

/**
 * @typedef {Object} QualificationRequirement
 * @property {string} summary — краткое описание критерия (без перечня документов)
 * @property {string} evidence — полный текст критерия из КД (цитата)
 * @property {string} [criteriaNumbers]
 * @property {string[]} [confirmationDocuments] — чем подтверждается (по одному виду документа)
 */

/**
 * @typedef {Object} OrgDocPeriodRule
 * @property {string} summary
 * @property {string} evidence
 * @property {string} [computedDeadlineHint]
 * @property {string} [computedPeriodHint]
 */

/**
 * @typedef {Object} AnalysisStructured
 * @property {string | null} tenderTitle
 * @property {string | null} sumOrBudget
 * @property {string | null} submissionOverview
 * @property {string | null} submissionMethod
 * @property {string | null} submissionDeadline
 * @property {QualificationRequirement[]} [qualificationRequirements]
 * @property {OrgDocPeriodRule | null} [bankReferenceDateRule]
 * @property {OrgDocPeriodRule | null} [balanceSheetPeriodRule]
 * @property {OrgDocPeriodRule | null} [incomeStatementPeriodRule]
 * @property {CpCompositionRequirement[]} [cpCompositionRequirements]
 * @property {{ name: string; basis: string; evidence?: string }[]} lenaCanPrepare
 * @property {{ name: string; reason: string; criteria: string; evidence?: string }[]} managerMustProvide
 */

/**
 * @typedef {ReturnType<typeof normalizeToCanonicalDocument> & { source?: "lena" | "manager" }} NormalizedDoc
 */

/**
 * Убирает хвосты «— Требование к…» и скобки с формулировками требований из КД.
 * @param {string} name
 */
export function stripRequirementParentheticals(name) {
  return String(name ?? "")
    .replace(/\s*[—–-]\s*(требован\w*|п\.?\s*\d+)[^.]*$/i, "")
    .replace(/\s*\([^)]*(?:требован\w*|участник\w*[-\s]резидент|нерезидент)[^)]*\)\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {{ name?: string, basis?: string, reason?: string, criteria?: string, evidence?: string }} item
 */
function requirementBlob(item) {
  return [item.name, item.basis, item.reason, item.criteria, item.evidence]
    .filter(Boolean)
    .join(" ");
}

/**
 * Пункт матрицы относится только к нерезидентам — не показываем (ГС Ритейл / Финсельват — резиденты РБ).
 * @param {{ name?: string, basis?: string, reason?: string, criteria?: string, evidence?: string }} item
 */
export function isNonResidentOnlyRequirement(item) {
  const blob = requirementBlob(item);
  if (/только\s+для\s+нерезидент|исключительно.*нерезидент|ветк\w*\s+нерезидент/i.test(blob)) {
    return true;
  }
  if (/нерезидент|не\s+резидент|иностранн\w*\s+участник/i.test(blob)) {
    if (/участник\w*[-\s]резидент|резидент\w*\s+рб|для\s+резидент/i.test(blob)) return false;
    return true;
  }
  if (/выписк\w*\s+из\s+торгового\s+реестра|выписк\w*\s+егр/i.test(blob)) {
    return true;
  }
  if (/торговый\s+реестр/i.test(blob) && /стран\w*\s+учрежден|нерезидент|иностранн/i.test(blob)) {
    return true;
  }
  return false;
}

/**
 * Пункт матрицы относится только к производителям — не показываем (ГС Ритейл / Финсельват — не производители).
 * @param {{ name?: string, basis?: string, reason?: string, criteria?: string, evidence?: string }} item
 */
export function isManufacturerOnlyRequirement(item) {
  const blob = requirementBlob(item);
  if (/представител|дилер|агентск|комиссионн|дистрибьютор/i.test(blob)) {
    if (/производител|производств/i.test(blob) && /\bили\b/i.test(blob)) return false;
    if (/официальн\s+представител|торговый\s+представител/i.test(blob)) return false;
  }
  if (
    /справка\s+тпп|торгово-промышленн|для\s+производител|сертификат\s+собственного\s+производства|подтверждени\w*\s+статуса\s+производител/i.test(
      blob,
    )
  ) {
    return true;
  }
  if (/производител/i.test(blob) && !/представител|дилер|агент/i.test(blob)) {
    return true;
  }
  return false;
}

/**
 * @param {{ name?: string, basis?: string, reason?: string, criteria?: string, evidence?: string }} item
 */
export function isExcludedParticipantRequirement(item) {
  return isNonResidentOnlyRequirement(item) || isManufacturerOnlyRequirement(item);
}

/** Документы, входящие в состав КП (раздел 2) — не отдельные строки «К подаче». */
const KP_EMBEDDED_DOC_IDS = new Set(["payment_terms", "warranty_letter"]);

/**
 * @param {{ id: string }} doc
 */
export function isKpEmbeddedChecklistItem(doc) {
  return KP_EMBEDDED_DOC_IDS.has(doc.id);
}

/**
 * Референс-лист — только если цитата из КД (evidence) содержит явное название документа.
 * @param {{ name?: string, basis?: string, reason?: string, criteria?: string, evidence?: string }} item
 */
export function isExplicitReferenceListRequirement(item) {
  const evidence = String(item.evidence ?? "").trim();
  const name = String(item.name ?? item.reason ?? "").trim();
  if (!evidence) return false;
  if (!/референс[-\s]?лист|reference\s+list/i.test(evidence)) return false;
  const blob = `${name}\n${evidence}`.trim();
  // «референс-лист или договоры/акты» — альтернатива, не отдельный обязательный документ
  if (
    /референс[-\s]?лист\s+(?:и\s+)?(?:или|либо)/i.test(blob) ||
    /(?:или|либо)\s+референс[-\s]?лист/i.test(blob) ||
    /(?:договор\w*|акт\w*)\s+(?:и\s+)?(?:или|либо)\s+.*референс/i.test(blob) ||
    /референс[-\s]?лист\s+(?:и\s+)?(?:или|либо)\s+.*(?:договор|акт)/i.test(blob)
  ) {
    return false;
  }
  // Опыт/квалификация через договоры и акты — не отдельный «референс-лист» в «К подаче»
  if (
    /(?:не\s+менее|квалификац|опыт\s+работ|договор\w*\s+.*акт)/i.test(blob) &&
    !/(?:отдельн\w*|самостоятельн\w*)\s+.*референс|предоставить\s+референс[-\s]?лист/i.test(blob)
  ) {
    return false;
  }
  return true;
}

/**
 * Критерии квалификации, ошибочно попавшие в managerMustProvide как «референс-лист» и т.п.
 * @param {{ name?: string, reason?: string, criteria?: string, evidence?: string }} item
 */
export function looksLikeQualificationCriteriaItem(item) {
  const blob = `${item.name ?? ""} ${item.reason ?? ""} ${item.criteria ?? ""} ${item.evidence ?? ""}`;
  return /не\s+менее|квалификац|опыт\s+работ|договор\w*.*акт|акт\w*.*выполнен/i.test(blob);
}

/**
 * Документ служит только подтверждением квалификации (резюме, дипломы, трудовые и т.п.).
 * @param {{ name?: string, reason?: string, criteria?: string, evidence?: string }} item
 */
export function looksLikeQualificationProofDocumentItem(item) {
  const blob = `${item.name ?? ""} ${item.reason ?? ""} ${item.criteria ?? ""} ${item.evidence ?? ""}`;
  return (
    /резюме|трудов.{0,16}книж|диплом|копи\w*\s+договор|акт.{0,24}выполн|проектн.{0,24}документ/i.test(blob) &&
    /квалификац|штат|опыт\s+участ|не\s+менее|работник/i.test(blob)
  );
}

/**
 * @param {AnalysisStructured} structured
 * @returns {AnalysisStructured}
 */
export function relocateQualificationMislabels(structured) {
  /** @type {QualificationRequirement[]} */
  const qualificationRequirements = [...(structured.qualificationRequirements ?? [])];
  /** @type {AnalysisStructured["managerMustProvide"]} */
  const managerMustProvide = [];

  for (const x of structured.managerMustProvide ?? []) {
    const n = normalizeToCanonicalDocument(stripRequirementParentheticals(x.name) || x.name);
    const mislabeledReference =
      (n.id === "reference_list" || (n.id === "other" && looksLikeQualificationCriteriaItem(x))) &&
      looksLikeQualificationCriteriaItem(x) &&
      !isExplicitReferenceListRequirement(x);
    const qualProofOnly = n.id === "other" && looksLikeQualificationProofDocumentItem(x);

    if (mislabeledReference || qualProofOnly) {
      const summary =
        (x.evidence?.trim() && x.evidence.trim().length > 20 ? x.evidence.trim() : null) ||
        (x.criteria && x.criteria !== "—" ? x.criteria : null) ||
        x.reason ||
        x.name;
      const proofName = stripRequirementParentheticals(x.name) || x.name;
      qualificationRequirements.push({
        summary: qualProofOnly && proofName.length <= 120 ? proofName : summary,
        evidence: x.evidence || summary,
        confirmationDocuments: qualProofOnly && proofName ? [proofName] : undefined,
      });
      continue;
    }
    managerMustProvide.push(x);
  }

  return { ...structured, qualificationRequirements, managerMustProvide };
}

/**
 * Декларации соответствия — только если цитата из КД/ТЗ содержит дословную формулировку.
 * @param {{ name?: string, basis?: string, reason?: string, criteria?: string, evidence?: string }} item
 */
export function isExplicitConformityDeclarationRequirement(item) {
  const evidence = String(item.evidence ?? "").trim();
  if (!evidence) return false;
  return /декларац\S*\s+соответств/i.test(evidence);
}

/**
 * Заявление о соответствии — только при дословной формулировке в evidence.
 * @param {{ name?: string, basis?: string, reason?: string, criteria?: string, evidence?: string }} item
 */
export function isExplicitComplianceStatementRequirement(item) {
  const evidence = String(item.evidence ?? "").trim();
  if (!evidence) return false;
  return /заявлени\S*\s+о\s+соответств/i.test(evidence);
}

/**
 * Техническое предложение — только при дословной формулировке в evidence.
 * Не путать с «техническим образованием», «техническом задании», «технологий ИИ».
 * @param {{ name?: string, basis?: string, reason?: string, criteria?: string, evidence?: string }} item
 */
export function isExplicitTechnicalProposalRequirement(item) {
  const evidence = String(item.evidence ?? "").trim();
  if (!evidence) return false;
  return /техническ\S*\s+предлож\S*|тех\s*\.?\s*предлож\S*|техпредлож\S*/i.test(evidence);
}

/**
 * Дилерское/агентское с производителем — не путать с доверенностью на подачу.
 * @param {{ name?: string, basis?: string, reason?: string, criteria?: string, evidence?: string }} item
 */
export function isExplicitDealerRepresentativeRequirement(item) {
  const evidence = String(item.evidence ?? "").trim();
  if (!evidence) return false;
  if (/доверенност/i.test(evidence) && !/дилерск|агентск|официальн\w*\s+представител/i.test(evidence)) {
    return false;
  }
  return /дилерск|агентск|официальн\w*\s+представител\w*\s+производител/i.test(evidence);
}

/**
 * Документ привязан к конкретному юрлицу (_lena/org-docs, _lena/founding-docs).
 * На шаге 1 показываем в полном «К подаче»; наличие на Drive проверяем только после выбора org.
 * @param {{ storage?: string }} doc
 */
export function isOrgBoundChecklistDocument(doc) {
  return doc.storage === "org" || doc.storage === "founding";
}

/**
 * @param {NormalizedDoc[]} docs
 */
export function filterPreOrgChecklistDocuments(docs) {
  return docs.filter((d) => !isOrgBoundChecklistDocument(d));
}

/**
 * @param {AnalysisStructured} structured
 * @param {string} canonicalId
 */
export function orgDocPeriodHintForStep1(structured, canonicalId) {
  if (canonicalId === "bank_reference") {
    const rule = structured.bankReferenceDateRule;
    if (rule?.summary?.trim()) return rule.summary.trim();
  }
  if (canonicalId === "balance_sheet") {
    const rule = structured.balanceSheetPeriodRule;
    if (rule?.summary?.trim()) return rule.summary.trim();
  }
  if (canonicalId === "income_statement") {
    const rule = structured.incomeStatementPeriodRule;
    if (rule?.summary?.trim()) return rule.summary.trim();
  }
  const item = structured.managerMustProvide?.find(
    (x) =>
      normalizeToCanonicalDocument(stripRequirementParentheticals(x.name) || x.name).id ===
      canonicalId,
  );
  const criteria = item?.criteria?.trim();
  if (criteria && criteria !== "—") return criteria;
  return null;
}

/** @deprecated use orgDocPeriodHintForStep1 */
export function bankReferenceDateHintForStep1(structured) {
  return orgDocPeriodHintForStep1(structured, "bank_reference");
}

export { isLenaPreparedChecklistItem };

/**
 * @param {string} corpus
 */
export function corpusMentionsCommercialProposal(corpus) {
  return /коммерческ\S*\s+предложен|коммерческ\S*предложен/i.test(String(corpus ?? ""));
}

/**
 * В КД явно требуется «предложение участника» / ценовое предложение (не только коммерческое).
 * @param {string} corpus
 */
export function corpusMentionsParticipantProposal(corpus) {
  const c = String(corpus ?? "");
  return (
    /предложени[а-яё]*\s+участник/i.test(c) ||
    /форм[а-яё]*\s+и\s+содержан[а-яё]*\s+предложени[а-яё]*\s+участник/i.test(c) ||
    /запрос\s+ценов[а-яё]*\s+предложен/i.test(c) ||
    /ценов[а-яё]*\s+предложен/i.test(c)
  );
}

/**
 * В корпусе inputs есть ветка п.3.2 про сертификат о происхождении для товаров не из СНГ.
 * @param {string} corpus
 */
export function corpusRequiresNonCisOriginCertificate(corpus) {
  const c = String(corpus ?? "");
  return (
    /не\s+являющ\w*\s+участник\w*\s+содружеств\w*\s+независим\w*\s+государств/i.test(c) ||
    /сертификат\s+о\s+происхождении\s+товар/i.test(c)
  );
}

/**
 * @param {{ name?: string, basis?: string, reason?: string, criteria?: string, evidence?: string }} item
 * @param {ReturnType<typeof normalizeToCanonicalDocument>} normalized
 */
export function shouldIncludeChecklistItem(item, normalized) {
  if (isKpEmbeddedChecklistItem(normalized)) return false;
  if (normalized.id === "reference_list" && !isExplicitReferenceListRequirement(item)) return false;
  if (
    normalized.id === "conformity_declarations" &&
    !isExplicitConformityDeclarationRequirement(item)
  ) {
    return false;
  }
  if (normalized.id === "compliance_statement" && !isExplicitComplianceStatementRequirement(item)) {
    return false;
  }
  if (
    normalized.id === "dealer_representative_docs" &&
    !isExplicitDealerRepresentativeRequirement(item)
  ) {
    return false;
  }
  if (normalized.id === "technical_proposal" && !isExplicitTechnicalProposalRequirement(item)) {
    // #region agent log
    checklistDebug714167(
      "documentChecklist.js:shouldIncludeChecklistItem",
      "technical_proposal filtered (no explicit evidence)",
      {
        name: String(item.name ?? item.reason ?? "").slice(0, 80),
        evidence: String(item.evidence ?? "").slice(0, 120),
      },
      "TP1",
    );
    // #endregion
    return false;
  }
  return true;
}

/**
 * @param {NormalizedDoc} doc
 */
export function submissionDisplayTitle(doc) {
  if (doc.id !== "other") return doc.title;
  const stripped = stripRequirementParentheticals(doc.rawName);
  const low = stripped.toLowerCase();
  if (low.includes("документы, указанные в") || low.includes("документы указанные в")) {
    return "Документы по техническому заданию";
  }
  return stripped || doc.title;
}

/**
 * @param {string} docId
 * @param {string} title
 */
export function uploadTargetDisplayTitle(docId, title) {
  if (docId === "dealer_representative_docs") {
    return `${title} (дилерское/агентское соглашение с производителем)`;
  }
  return title;
}

/**
 * @param {AnalysisStructured} structured
 * @returns {AnalysisStructured}
 */
export function applyCanonicalNamesToStructured(structured) {
  const mapItems = (items) =>
    items
      .filter((x) => !isExcludedParticipantRequirement(x))
      .map((x) => {
        const n = normalizeToCanonicalDocument(stripRequirementParentheticals(x.name) || x.name);
        return { ...x, name: n.title, _normalized: n };
      })
      .filter((x) => shouldIncludeChecklistItem(x, x._normalized))
      .map(({ _normalized, ...x }) => x);

  return {
    ...structured,
    qualificationRequirements: structured.qualificationRequirements ?? [],
    bankReferenceDateRule: structured.bankReferenceDateRule ?? null,
    balanceSheetPeriodRule: structured.balanceSheetPeriodRule ?? null,
    incomeStatementPeriodRule: structured.incomeStatementPeriodRule ?? null,
    cpCompositionRequirements: structured.cpCompositionRequirements ?? [],
    lenaCanPrepare: mapItems(structured.lenaCanPrepare),
    managerMustProvide: mapItems(structured.managerMustProvide),
  };
}

/**
 * @param {import("./canonicalDocumentTypes.js").DocumentPreparedBy} preparedBy
 * @param {{ name: string }[]} items
 * @returns {NormalizedDoc[]}
 */
function normalizeItemList(preparedBy, items) {
  /** @type {Map<string, NormalizedDoc>} */
  const map = new Map();
  for (const x of items) {
    if (isExcludedParticipantRequirement(x)) continue;
    const cleanName = stripRequirementParentheticals(x.name) || x.name;
    const n = normalizeToCanonicalDocument(cleanName);
    if (n.id === "egr_extract") continue;
    if (!shouldIncludeChecklistItem(x, n)) continue;
    const key = n.id !== "other" ? n.id : `other:${n.rawName}`;
    const existing = map.get(key);
    const source = preparedBy;
    if (!existing) {
      map.set(key, { ...n, source });
      continue;
    }
    if (preparedBy === "lena" && existing.source === "manager") {
      map.set(key, { ...existing, ...n, source: "lena", preparedByDefault: "lena" });
    }
  }
  return [...map.values()];
}

/** @type {Map<string, number>} */
const CANONICAL_ORDER = new Map(
  CANONICAL_DOCUMENT_TYPES.map((d, i) => [d.id, i]),
);

/**
 * Порядок для списка «К подаче»: КП первым, затем по реестру эталона, прочее — по алфавиту.
 * @param {NormalizedDoc[]} docs
 * @returns {NormalizedDoc[]}
 */
export function sortSubmissionDocuments(docs) {
  return [...docs].sort((a, b) => {
    if (a.id === "commercial_proposal" && b.id !== "commercial_proposal") return -1;
    if (b.id === "commercial_proposal" && a.id !== "commercial_proposal") return 1;
    const ao = a.id === "other" ? 9999 : (CANONICAL_ORDER.get(a.id) ?? 5000);
    const bo = b.id === "other" ? 9999 : (CANONICAL_ORDER.get(b.id) ?? 5000);
    if (ao !== bo) return ao - bo;
    return a.title.localeCompare(b.title, "ru");
  });
}

/**
 * Плоский список состава документов по КД (шаг 1 Telegram).
 * @param {AnalysisStructured} structured
 * @param {{ corpus?: string }} [opts]
 */
export function buildRequiredDocumentsList(structured, opts = {}) {
  const lena = normalizeItemList("lena", structured.lenaCanPrepare);
  const mgr = normalizeItemList("manager", structured.managerMustProvide);
  /** @type {Map<string, NormalizedDoc>} */
  const all = new Map();
  for (const d of [...lena, ...mgr]) {
    const key = d.id !== "other" ? d.id : `other:${d.rawName}`;
    if (!all.has(key)) all.set(key, d);
  }
  let list = sortSubmissionDocuments([...all.values()]);
  const corpus = opts.corpus?.trim();
  const hasProposalDoc = list.some(
    (d) =>
      d.id === "commercial_proposal" ||
      d.id === "application_form" ||
      (d.id === "other" && /предложени|ценов[а-яё]*\s+предложен/i.test(d.rawName ?? "")),
  );
  if (
    !hasProposalDoc &&
    corpus &&
    (corpusMentionsCommercialProposal(corpus) || corpusMentionsParticipantProposal(corpus))
  ) {
    list = sortSubmissionDocuments([
      { ...normalizeToCanonicalDocument("Коммерческое предложение"), source: "lena" },
      ...list,
    ]);
  }
  if (
    corpus &&
    corpusRequiresNonCisOriginCertificate(corpus) &&
    !list.some((d) => d.id === "certificate_of_origin")
  ) {
    list = sortSubmissionDocuments([
      ...list,
      {
        ...normalizeToCanonicalDocument("Сертификат о происхождении товара"),
        source: "manager",
      },
    ]);
  }
  return list;
}

/**
 * @param {NormalizedDoc[]} requiredDocuments
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {AnalysisStructured} structured
 */
export function buildRefinedChecklist(requiredDocuments, offerOrg, structured) {
  const lenaFromAnalysis = new Set(
    normalizeItemList("lena", structured.lenaCanPrepare).map((d) =>
      d.id !== "other" ? d.id : `other:${d.rawName}`,
    ),
  );

  /** @type {NormalizedDoc[]} */
  const lenaPrepare = [];
  /** @type {NormalizedDoc[]} */
  const managerUpload = [];

  for (const d of requiredDocuments) {
    const key = d.id !== "other" ? d.id : `other:${d.rawName}`;
    const fromLena = d.source === "lena" || lenaFromAnalysis.has(key) || d.preparedByDefault === "lena";
    if (fromLena && d.preparedByDefault !== "manager") {
      lenaPrepare.push(d);
    } else {
      managerUpload.push(d);
    }
  }

  return { lenaPrepare, managerUpload, offerOrg };
}

/**
 * @param {string} s
 */
function normalizeQualificationSpace(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Разбивает текст критерия на суть и перечень подтверждающих документов (fallback без LLM-поля).
 * @param {string} text
 * @returns {{ criterionShort: string, confirmationDocuments: string[] }}
 */
export function parseQualificationConfirmation(text) {
  const t = normalizeQualificationSpace(text);
  if (!t) return { criterionShort: "", confirmationDocuments: [] };

  const splitRe =
    /(?:^|\s|[.;,])(?:подтвержда(?:ется|ются)|факт\s+(?:реализации\s+и\s+)?(?:внедрения\s+)?подтвержда(?:ется|ются)|с\s+предоставлением\s+(?:копий|документов|необходимых)|предоставить(?:\s+не\s+менее)?\s+(?:копий|документов)?)\s+/i;
  const m = t.match(splitRe);
  if (!m || m.index === undefined) {
    return { criterionShort: t, confirmationDocuments: [] };
  }

  const criterionShort = t.slice(0, m.index).trim().replace(/[.;,\s]+$/, "");
  const confirmPart = t.slice(m.index + m[0].length).trim();
  return {
    criterionShort: criterionShort || t,
    confirmationDocuments: splitConfirmationDocumentList(confirmPart),
  };
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function splitConfirmationDocumentList(text) {
  let s = normalizeQualificationSpace(text)
    .replace(/^(?:копий|копии|документов|необходимых\s+документов)\s+/i, "")
    .replace(/\.$/, "")
    .trim();
  if (!s) return [];

  /** @type {string[]} */
  const parts = [];
  for (const chunk of s.split(
    /\s*,\s*(?:а\s+также|и)\s+|\s*,\s*(?=резюме|выписк|коп|диплом|акт)|\s+и\s+(?=акт|диплом|резюме|выписк|коп)|\s*;\s+/i,
  )) {
    const piece = chunk.trim().replace(/^[.:]\s*/, "");
    if (piece.length > 3) parts.push(piece);
  }
  if (!parts.length && s.length > 3) parts.push(s);
  return parts;
}

/**
 * @param {QualificationRequirement} item
 * @returns {QualificationRequirement}
 */
export function enrichQualificationRequirementForDisplay(item) {
  const evidence = normalizeQualificationSpace(item.evidence);
  let summary = normalizeQualificationSpace(item.summary);
  /** @type {string[]} */
  let confirmationDocuments = (item.confirmationDocuments ?? [])
    .map((d) => normalizeQualificationSpace(d))
    .filter((d) => d.length > 3);

  if (!confirmationDocuments.length) {
    const fromEvidence = parseQualificationConfirmation(evidence);
    const fromSummary = parseQualificationConfirmation(summary);
    confirmationDocuments =
      fromEvidence.confirmationDocuments.length >= fromSummary.confirmationDocuments.length
        ? fromEvidence.confirmationDocuments
        : fromSummary.confirmationDocuments;
    if (fromEvidence.criterionShort && fromEvidence.confirmationDocuments.length) {
      summary = fromEvidence.criterionShort;
    } else if (fromSummary.criterionShort && fromSummary.confirmationDocuments.length) {
      summary = fromSummary.criterionShort;
    }
  }

  if (!summary && evidence) summary = evidence.slice(0, 160);
  if (summary && evidence && normalizeQualificationSpace(summary) === normalizeQualificationSpace(evidence)) {
    const parsed = parseQualificationConfirmation(evidence);
    if (parsed.criterionShort) summary = parsed.criterionShort;
  }

  return {
    ...item,
    summary: summary || evidence,
    evidence: evidence || summary,
    confirmationDocuments: confirmationDocuments.length ? confirmationDocuments : undefined,
  };
}

/**
 * @param {QualificationRequirement[]} items
 * @returns {QualificationRequirement[]}
 */
export function splitMergedQualificationRequirements(items) {
  /** @type {QualificationRequirement[]} */
  const out = [];
  const staffMarker =
    /(?:^|[.;]\s*|\s)(?:наличие\s+в\s+штате|в\s+штате\s+не\s+менее|не\s+менее\s+двух\s+работник)/i;
  const experienceMarker =
    /опыт\s+работ\w*\s+на\s+рынке|рынк\w*\s+информационн\w*\s+технолог|не\s+менее\s+3\s*(?:\(тр[её]х\)|тр[её]х|\d)?\s*(?:\(тр[её]х\)|лет|г\.)/i;

  for (const item of items) {
    const blob = normalizeQualificationSpace(item.evidence || item.summary);
    const staffMatch = blob.match(staffMarker);
    if (
      staffMatch &&
      staffMatch.index !== undefined &&
      experienceMarker.test(blob) &&
      staffMatch.index > 40
    ) {
      const experienceText = blob.slice(0, staffMatch.index).trim().replace(/[.;,\s]+$/, "");
      const staffText = blob.slice(staffMatch.index).trim();
      if (experienceText.length > 30 && staffText.length > 30) {
        out.push({
          ...item,
          summary: item.summary && item.summary.length < experienceText.length ? item.summary : experienceText.slice(0, 220),
          evidence: item.evidence && /опыт|проект|рынк/i.test(item.evidence) ? item.evidence : experienceText,
          confirmationDocuments: item.confirmationDocuments?.filter((d) => /договор|акт|проект/i.test(d)),
        });
        out.push({
          summary: staffText.slice(0, 220),
          evidence: staffText,
          confirmationDocuments: item.confirmationDocuments?.filter((d) =>
            /диплом|резюме|трудов|проектн/i.test(d),
          ),
        });
        continue;
      }
    }
    out.push(item);
  }
  return out;
}

/**
 * @param {QualificationRequirement[]} items
 * @returns {QualificationRequirement[]}
 */
export function dedupeQualificationRequirements(items) {
  const seen = new Set();
  /** @type {QualificationRequirement[]} */
  const out = [];
  for (const raw of splitMergedQualificationRequirements(items)) {
    const x = enrichQualificationRequirementForDisplay(raw);
    const key = normalizeQualificationSpace(x.evidence || x.summary)
      .toLowerCase()
      .slice(0, 220);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  return out;
}

/**
 * @param {QualificationRequirement} item
 */
export function formatQualificationRequirementTelegramBlock(item) {
  const enriched = enrichQualificationRequirementForDisplay(item);
  const short = enriched.summary?.trim() || enriched.evidence?.trim() || "Критерий";
  const full = enriched.evidence?.trim() || "";
  const docs = enriched.confirmationDocuments ?? [];

  let block = `- ${short}`;
  if (full && normalizeQualificationSpace(full) !== normalizeQualificationSpace(short)) {
    block += ` [${full}]`;
  }
  if (docs.length) {
    block += ":\n" + docs.map((d) => `  • ${d.replace(/^[-•]\s*/, "")}`).join("\n");
  } else {
    block += ":\n  • _(подтверждающие документы не выделены — см. цитату)_";
  }
  return block;
}

/** Документы заявки, которые не считаются только подтверждением квалификации. */
const STEP1_ALWAYS_INCLUDE_DOC_IDS = new Set([
  "commercial_proposal",
  "technical_proposal",
  "application_form",
  "state_registration_certificate",
  "power_of_attorney",
  "compliance_statement",
  "written_consent_contract",
  "bank_reference",
  "balance_sheet",
  "income_statement",
  "reliability_letter",
  "charter",
  "founding_documents",
  "dealer_representative_docs",
  "certificate_of_origin",
  "conformity_declarations",
  "budget_debt_statement",
  "warranty_letter",
  "payment_terms",
]);

const QUALIFICATION_PROOF_KEYWORD_RE =
  /резюме|трудов.{0,16}книж|диплом|договор|акт.{0,24}выполн|проектн.{0,24}документ/i;

/**
 * @param {AnalysisStructured} structured
 * @returns {string[]}
 */
export function collectQualificationProofLabels(structured) {
  return prepareQualificationForStep1Display(structured.qualificationRequirements ?? []).proofDocuments;
}

/**
 * @param {NormalizedDoc} doc
 * @param {string[]} proofLabels
 */
export function documentCoveredByQualificationProof(doc, proofLabels) {
  if (!proofLabels.length) return false;
  if (STEP1_ALWAYS_INCLUDE_DOC_IDS.has(doc.id)) return false;

  const title = normalizeQualificationSpace(submissionDisplayTitle(doc)).toLowerCase();
  const raw = normalizeQualificationSpace(doc.rawName || doc.title || "").toLowerCase();
  const blob = `${title} ${raw}`;

  if (doc.id === "reference_list") {
    return proofLabels.some((p) => /договор|акт|опыт|проект/i.test(p));
  }

  if (!QUALIFICATION_PROOF_KEYWORD_RE.test(blob)) return false;

  return proofLabels.some((proof) => {
    const p = normalizeQualificationSpace(proof).toLowerCase();
    if (!p) return false;
    if (title.includes(p) || p.includes(title)) return true;
    if (/резюме/.test(blob) && /резюме/.test(p)) return true;
    if (/трудов/.test(blob) && /трудов/.test(p)) return true;
    if (/диплом/.test(blob) && /диплом/.test(p)) return true;
    if (/договор/.test(blob) && /договор/.test(p)) return true;
    if (/акт/.test(blob) && /акт/.test(p)) return true;
    if (/проектн/.test(blob) && /проектн/.test(p)) return true;
    return false;
  });
}

/**
 * Заголовок блока документов пакета на шаге 1 (Telegram).
 */
export const PACKAGE_SECTION_HEADER = "**Кроме того пакет должен содержать:**";

/**
 * Список «Кроме того пакет должен содержать» — без документов, уже перечисленных в квалификации.
 * @param {NormalizedDoc[]} requiredDocuments
 * @param {AnalysisStructured} structured
 */
export function filterStep1SubmissionDocuments(requiredDocuments, structured) {
  const proofLabels = collectQualificationProofLabels(structured);
  if (!proofLabels.length) return requiredDocuments;
  return requiredDocuments.filter((d) => !documentCoveredByQualificationProof(d, proofLabels));
}

/**
 * Пункт только про подтверждающие документы без порога критерия — не отдельная строка квалификации.
 * @param {QualificationRequirement} item
 */
export function isQualificationConfirmationOnlyItem(item) {
  const enriched = enrichQualificationRequirementForDisplay(item);
  const blob = normalizeQualificationSpace(`${enriched.summary} ${enriched.evidence}`);
  const hasCriterion =
    /не\s+менее|штат|опыт\s+работ|(?:\d+\s*)?(?:лет|г\.|руб|byn)|работник|проект\w*\s+.*(?:ии|и)/i.test(
      blob,
    );
  if (hasCriterion) return false;
  return (
    /^(?:факт\s+(?:реализации|наличия)|предоставлени\w+\s+копий|подтвержда(?:ется|ются)|с\s+предоставлением)/i.test(
      blob.trim(),
    ) || (enriched.confirmationDocuments?.length ?? 0) > 0
  );
}

/**
 * @param {string[]} docs
 */
function dedupeProofDocStrings(docs) {
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const raw of docs) {
    const d = normalizeQualificationSpace(raw);
    if (d.length <= 3) continue;
    const key = normalizeQualificationSpace(d)
      .toLowerCase()
      .replace(/^коп(?:ии|ия|иями|ий)\s+/i, "")
      .replace(/^акт(?:ов|ы)?\s+/i, "акт ")
      .replace(/\s+/g, " ")
      .trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * @param {QualificationRequirement[]} items
 */
export function prepareQualificationForStep1Display(items) {
  /** @type {string[]} */
  const extraProofDocs = [];
  /** @type {QualificationRequirement[]} */
  const criteriaRaw = [];
  for (const item of items ?? []) {
    if (isQualificationConfirmationOnlyItem(item)) {
      const enriched = enrichQualificationRequirementForDisplay(item);
      extraProofDocs.push(...(enriched.confirmationDocuments ?? []));
      extraProofDocs.push(
        ...parseQualificationConfirmation(enriched.evidence || enriched.summary).confirmationDocuments,
      );
      continue;
    }
    criteriaRaw.push(item);
  }
  const criteriaItems = dedupeQualificationRequirements(criteriaRaw);
  const proofDocuments = dedupeProofDocStrings([
    ...extraProofDocs,
    ...criteriaItems.flatMap((x) => x.confirmationDocuments ?? []),
  ]);
  return { criteriaItems, proofDocuments };
}

/**
 * @param {QualificationRequirement} item
 * @param {number} index
 */
export function formatQualificationCriterionTelegramLine(item, index) {
  const enriched = enrichQualificationRequirementForDisplay(item);
  const short = enriched.summary?.trim() || enriched.evidence?.trim() || "Критерий";
  const full = enriched.evidence?.trim() || "";
  let line = `${index}. ${short}`;
  if (full && normalizeQualificationSpace(full) !== normalizeQualificationSpace(short)) {
    line += ` [${full}]`;
  }
  return line;
}

/**
 * @param {string[]} proofDocuments
 */
export function formatQualificationProofDocumentsTelegram(proofDocuments) {
  if (!proofDocuments.length) return "";
  return [
    "**Требования к квалификации подтвердить документами:**",
    ...proofDocuments.map((d) => `- ${d.replace(/^[-•]\s*/, "")}`),
  ].join("\n");
}

/**
 * @param {AnalysisStructured} structured
 */
export function formatQualificationRequirementsTelegram(structured) {
  const { criteriaItems, proofDocuments } = prepareQualificationForStep1Display(
    structured.qualificationRequirements ?? [],
  );
  if (!criteriaItems.length && !proofDocuments.length) return "";

  /** @type {string[]} */
  const blocks = [];
  if (criteriaItems.length) {
    blocks.push(
      "**Требования к квалификации:**",
      ...criteriaItems.map((x, i) => formatQualificationCriterionTelegramLine(x, i + 1)),
    );
  }
  const proofBlock = formatQualificationProofDocumentsTelegram(proofDocuments);
  if (proofBlock) blocks.push(proofBlock);

  // #region agent log
  fetch("http://127.0.0.1:7273/ingest/0fbf9c34-aa58-4c41-8b66-36b66355e6e0", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "714167" },
    body: JSON.stringify({
      sessionId: "714167",
      location: "documentChecklist.js:formatQualificationRequirementsTelegram",
      message: "qualification telegram block rendered",
      data: {
        criteriaCount: criteriaItems.length,
        proofDocCount: proofDocuments.length,
        hasProofSection: Boolean(proofBlock),
      },
      hypothesisId: "Q1-Q3",
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  return blocks.join("\n");
}

/**
 * @param {AnalysisStructured} structured
 * @param {NormalizedDoc[]} requiredDocuments
 * @param {string | undefined} inputsFolderWebViewLink
 */
export function formatDocumentCompositionStep1Telegram(
  structured,
  requiredDocuments,
  inputsFolderWebViewLink,
) {
  const docsLink = inputsFolderWebViewLink?.trim();
  const lines = [
    docsLink
      ? `**Документы заказчика:** ${docsLink}`
      : "**Документы заказчика:** — _(папка inputs на Drive)_",
    "",
  ];

  const qualBlock = formatQualificationRequirementsTelegram(structured);
  if (qualBlock) {
    lines.push(qualBlock);
    lines.push("");
  }

  const step1Documents = filterStep1SubmissionDocuments(requiredDocuments, structured);

  // #region agent log
  fetch("http://127.0.0.1:7273/ingest/0fbf9c34-aa58-4c41-8b66-36b66355e6e0", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "714167" },
    body: JSON.stringify({
      sessionId: "714167",
      location: "documentChecklist.js:formatDocumentCompositionStep1Telegram",
      message: "step1 composition rendered",
      data: {
        hasQualBlock: Boolean(qualBlock),
        qualHasProofSection: /подтвердить документами/.test(qualBlock),
        step1DocCount: step1Documents.length,
        requiredDocCount: requiredDocuments.length,
        step1Titles: step1Documents.map((d) => submissionDisplayTitle(d)).slice(0, 12),
      },
      hypothesisId: "Q2-Q4",
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  if (step1Documents.length) {
    lines.push(PACKAGE_SECTION_HEADER);
    for (const d of step1Documents) {
      let line = `- ${submissionDisplayTitle(d)}`;
      const periodHint = orgDocPeriodHintForStep1(structured, d.id);
      if (periodHint && (d.id === "bank_reference" || d.id === "balance_sheet" || d.id === "income_statement")) {
        line += ` _(${periodHint})_`;
      }
      lines.push(line);
    }
    lines.push("");
    lines.push("_После выбора участника — проверка наличия документов организации на Drive._");
    lines.push("");
  } else if (qualBlock) {
    lines.push(PACKAGE_SECTION_HEADER);
    lines.push("- _(дополнительных документов пакета вне квалификации не выделено)_");
    lines.push("");
    lines.push("_После выбора участника — проверка наличия документов организации на Drive._");
    lines.push("");
  } else if (!qualBlock) {
    lines.push("- _(в КД не выделены требования с цитатой — проверьте парсинг.)_");
  }

  return lines.join("\n").trimEnd();
}

/** Текст предупреждения после повторной проверки догрузки (Telegram step recheck). */
export const UPLOAD_RECHECK_DISCLAIMER =
  "Вы можете загрузить не все документы — тогда они **не будут включены** в пакет документов для подачи.";

/**
 * @param {{ doc: NormalizedDoc, verify: import("./verifyDocumentAvailability.js").DocumentVerifyResult }[]} verifyResults
 * @param {AnalysisStructured} structured
 */
export function partitionVerifyResultsForChecklist(verifyResults, structured) {
  /** @type {typeof verifyResults} */
  const alreadyHave = [];
  /** @type {typeof verifyResults} */
  const lenaPrepare = [];
  /** @type {typeof verifyResults} */
  const needUpload = [];

  for (const row of verifyResults) {
    const { doc, verify } = row;
    if (isVerifyStatusAlreadyHave(verify.status, doc.id)) {
      alreadyHave.push(row);
    } else if (shouldShowInLenaPrepareBlock(doc, verify, structured)) {
      lenaPrepare.push(row);
    } else if (isVerifyStatusNeedsUpload(verify.status)) {
      needUpload.push(row);
    } else {
      needUpload.push(row);
    }
  }

  return { alreadyHave, lenaPrepare, needUpload };
}

/**
 * @param {ReturnType<typeof partitionVerifyResultsForChecklist>["needUpload"]} needUpload
 * @param {Map<string, string | undefined>} linkById
 */
function formatNeedUploadTelegramLines(needUpload, linkById) {
  const lines = [];
  for (const { doc, verify } of needUpload) {
    const link = linkById.get(doc.id);
    const titleLine = uploadTargetDisplayTitle(doc.id, doc.title);
    if (link) {
      lines.push(`- ${titleLine} — [загрузить](${link})${formatVerifyTelegramSuffix(verify)}`);
    } else {
      lines.push(`- ${titleLine}${formatVerifyTelegramSuffix(verify)}`);
    }
  }
  return lines;
}

/**
 * Сообщение после «Документы загружены»: повторная проверка Drive + ссылки + предупреждение.
 * @param {{ doc: NormalizedDoc, verify: import("./verifyDocumentAvailability.js").DocumentVerifyResult }[]} verifyResults
 * @param {import("./ensureDocumentUploadTargets.js").DocumentUploadTarget[]} uploadTargets
 * @param {AnalysisStructured} structured
 * @param {{ submissionFolderLink?: string | null }} [opts]
 */
export function formatUploadRecheckTelegram(verifyResults, uploadTargets, structured, opts = {}) {
  const linkById = new Map(uploadTargets.map((t) => [t.docId, t.webViewLink]));
  const { alreadyHave, lenaPrepare, needUpload } = partitionVerifyResultsForChecklist(
    verifyResults,
    structured,
  );

  const lines = ["**Проверка загрузки**", ""];

  lines.push("**Найдено на Drive:**");
  if (!alreadyHave.length) {
    lines.push("- (пока ничего не найдено на Drive)");
  } else {
    for (const { doc, verify } of alreadyHave) {
      lines.push(`- ${submissionDisplayTitle(doc)}${formatVerifyTelegramSuffix(verify)}`);
    }
  }

  lines.push("", "**Ещё не загружено:**");
  if (!needUpload.length) {
    lines.push("- Все обязательные для догрузки файлы найдены");
  } else {
    lines.push(...formatNeedUploadTelegramLines(needUpload, linkById));
  }

  if (lenaPrepare.length) {
    lines.push("", "**Подготовлю сама** (догрузка не требуется):");
    for (const { doc } of lenaPrepare) {
      lines.push(`- ${submissionDisplayTitle(doc)}`);
    }
  }

  lines.push("", UPLOAD_RECHECK_DISCLAIMER);

  if (opts.submissionFolderLink) {
    lines.push("", `**Комплект для печати:** [submission](${opts.submissionFolderLink})`);
  }

  return lines.join("\n");
}

/**
 * @param {AnalysisStructured} structured
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {string} orgLabel
 * @param {{ doc: NormalizedDoc, verify: import("./verifyDocumentAvailability.js").DocumentVerifyResult }[]} verifyResults
 * @param {import("./ensureDocumentUploadTargets.js").DocumentUploadTarget[]} uploadTargets
 * @param {Map<string, Awaited<ReturnType<typeof resolveDocumentFormSource>>>} [formHints]
 */
export function formatRefinedChecklistStep2Telegram(
  structured,
  offerOrg,
  orgLabel,
  verifyResults,
  uploadTargets,
  formHints = new Map(),
) {
  const title = structured.tenderTitle?.trim() || "Закупка";
  const linkById = new Map(uploadTargets.map((t) => [t.docId, t.webViewLink]));

  const lines = [`**${title}**`, `Участник: **${orgLabel}**`, ""];

  const qualBlock = formatQualificationRequirementsTelegram(structured);
  if (qualBlock) {
    lines.push(qualBlock, "");
  }

  const { alreadyHave, lenaPrepare, needUpload } = partitionVerifyResultsForChecklist(
    verifyResults,
    structured,
  );

  lines.push("**Уже есть:**");
  if (!alreadyHave.length) {
    lines.push("- (пока ничего не найдено на Drive)");
  } else {
    for (const { doc, verify } of alreadyHave) {
      lines.push(`- ${submissionDisplayTitle(doc)}${formatVerifyTelegramSuffix(verify)}`);
    }
  }

  lines.push("", "**Подготовлю сама:**");
  if (!lenaPrepare.length) {
    lines.push("- (нет пунктов с опорой в КД — уточните по документам.)");
  } else {
    for (const { doc, verify } of lenaPrepare) {
      const key = doc.id !== "other" ? doc.id : `other:${doc.rawName}`;
      const formHint = formHints.get(key);
      const formSuffix = formHint ? formatFormSourceTelegramHint(formHint) : "";
      const verifySuffix =
        verify.status === "form_customer" || verify.status === "form_template"
          ? formatVerifyTelegramSuffix(verify)
          : verify.status === "lena_draft" && verify.note
            ? ` — (${verify.note})`
            : "";
      lines.push(`- ${submissionDisplayTitle(doc)}${formSuffix || verifySuffix}`);
    }
  }

  lines.push("", "**Нужно получить / догрузить:**");
  if (!needUpload.length) {
    lines.push("- (нет — переходите к условиям.)");
  } else {
    lines.push(...formatNeedUploadTelegramLines(needUpload, linkById));
  }

  return lines.join("\n");
}

/**
 * @param {string} userRootId
 * @param {string} tenderId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {string} orgLabel
 * @param {AnalysisStructured} structured
 * @param {NormalizedDoc[]} requiredDocuments
 * @param {{ flat?: boolean, year?: string }} treeOpts
 * @param {{ corpus?: string, inputFiles?: { name?: string, id?: string, mimeType?: string }[] }} [bundleOpts]
 */
export async function buildRefinedChecklistTelegramBundle(
  userRootId,
  tenderId,
  offerOrg,
  orgLabel,
  structured,
  requiredDocuments,
  treeOpts,
  bundleOpts = {},
) {
  const t0 = Date.now();
  // #region agent log
  checklistDebug714167(
    "documentChecklist.js:buildRefinedChecklistTelegramBundle",
    "step2 bundle start",
    { tenderId, offerOrg, docCount: requiredDocuments.length },
    "H1",
  );
  // #endregion

  if (bundleOpts.runIngest !== false) {
    try {
      await ingestUploadedDocuments(
        userRootId,
        tenderId,
        offerOrg,
        requiredDocuments,
        structured,
        { flat: treeOpts.flat, year: treeOpts.year },
      );
    } catch {
      /* ingest optional on network errors */
    }
  }

  const verifyResults = await verifyDocumentsForChecklist(
    userRootId,
    tenderId,
    offerOrg,
    requiredDocuments,
    structured,
    {
      flat: treeOpts.flat,
      year: treeOpts.year,
      inputFiles: bundleOpts.inputFiles,
      corpus: bundleOpts.corpus ?? "",
    },
  );
  // #region agent log
  checklistDebug714167(
    "documentChecklist.js:buildRefinedChecklistTelegramBundle",
    "verifyDocumentsForChecklist done",
    { tenderId, offerOrg, ms: Date.now() - t0, verifyCount: verifyResults.length },
    "H1",
  );
  // #endregion

  const needUploadDocs = verifyResults
    .filter(({ doc, verify }) => {
      if (shouldShowInLenaPrepareBlock(doc, verify, structured)) return false;
      if (isVerifyStatusAlreadyHave(verify.status, doc.id)) return false;
      return true;
    })
    .map(({ doc }) => doc);

  const uploadTargets = await ensureDocumentUploadTargets(
    userRootId,
    tenderId,
    offerOrg,
    needUploadDocs.map((d) => ({ id: d.id, title: d.title, storage: d.storage })),
    treeOpts,
  );
  // #region agent log
  checklistDebug714167(
    "documentChecklist.js:buildRefinedChecklistTelegramBundle",
    "ensureDocumentUploadTargets done",
    { tenderId, uploadTargetCount: uploadTargets.length, ms: Date.now() - t0 },
    "H4",
  );
  // #endregion

  let inputFiles = bundleOpts.inputFiles;
  if (!inputFiles?.length) {
    const { tender } = await ensureTenderTree(userRootId, tenderId, treeOpts);
    inputFiles = await listChildren(tender.inputsId);
  }

  /** @type {Map<string, Awaited<ReturnType<typeof resolveDocumentFormSource>>>} */
  const formHints = new Map();
  for (const { doc, verify } of verifyResults) {
    if (!shouldShowInLenaPrepareBlock(doc, verify, structured)) continue;
    const key = doc.id !== "other" ? doc.id : `other:${doc.rawName}`;
    const pickTemplateStrategy =
      doc.id === "budget_debt_statement" ? "most_complete" : "best_match";
    formHints.set(
      key,
      await resolveDocumentFormSource(userRootId, offerOrg, doc, {
        inputFiles,
        corpus: bundleOpts.corpus ?? "",
        pickTemplateStrategy,
      }),
    );
  }

  const { lenaPrepare, managerUpload } = buildRefinedChecklist(requiredDocuments, offerOrg, structured);

  let submissionFolderLink = null;
  if (bundleOpts.syncSubmission !== false) {
    try {
      const manifest = await syncSubmissionPackage(
        userRootId,
        tenderId,
        offerOrg,
        requiredDocuments,
        structured,
        treeOpts,
      );
      submissionFolderLink = manifest.submissionFolderWebViewLink;
    } catch {
      submissionFolderLink = await resolveSubmissionFolderLink(userRootId, tenderId, treeOpts);
    }
  }

  const text = formatRefinedChecklistStep2Telegram(
    structured,
    offerOrg,
    orgLabel,
    verifyResults,
    uploadTargets,
    formHints,
  );
  // #region agent log
  checklistDebug714167(
    "documentChecklist.js:buildRefinedChecklistTelegramBundle",
    "step2 bundle done",
    { tenderId, textLen: text.length, ms: Date.now() - t0 },
    "H1",
  );
  // #endregion
  return {
    text,
    lenaPrepare,
    managerUpload,
    uploadTargets,
    formHints,
    verifyResults,
    submissionFolderLink,
  };
}
