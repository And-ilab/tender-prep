import {
  CANONICAL_DOCUMENT_TYPES,
  normalizeToCanonicalDocument,
} from "./canonicalDocumentTypes.js";
import { ensureDocumentUploadTargets } from "./ensureDocumentUploadTargets.js";

/**
 * @typedef {Object} AnalysisStructured
 * @property {string | null} tenderTitle
 * @property {string | null} sumOrBudget
 * @property {string | null} submissionOverview
 * @property {string | null} submissionMethod
 * @property {string | null} submissionDeadline
 * @property {{ name: string; basis: string }[]} lenaCanPrepare
 * @property {{ name: string; reason: string; criteria: string }[]} managerMustProvide
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
 * Пункт матрицы относится только к нерезидентам — не показываем (ГС Ритейл / Финсельват — резиденты РБ).
 * @param {{ name?: string, basis?: string, reason?: string, criteria?: string, evidence?: string }} item
 */
export function isNonResidentOnlyRequirement(item) {
  const blob = [item.name, item.basis, item.reason, item.criteria, item.evidence]
    .filter(Boolean)
    .join(" ");
  if (/только\s+для\s+нерезидент|исключительно.*нерезидент|ветк\w*\s+нерезидент/i.test(blob)) {
    return true;
  }
  if (/нерезидент|не\s+резидент|иностранн\w*\s+участник/i.test(blob)) {
    if (/участник\w*[-\s]резидент|резидент\w*\s+рб|для\s+резидент/i.test(blob)) return false;
    return true;
  }
  return false;
}

/**
 * @param {NormalizedDoc} doc
 */
export function submissionDisplayTitle(doc) {
  if (doc.id !== "other") return doc.title;
  const stripped = stripRequirementParentheticals(doc.rawName);
  return stripped || doc.title;
}

/**
 * @param {AnalysisStructured} structured
 * @returns {AnalysisStructured}
 */
export function applyCanonicalNamesToStructured(structured) {
  return {
    ...structured,
    lenaCanPrepare: structured.lenaCanPrepare
      .filter((x) => !isNonResidentOnlyRequirement(x))
      .map((x) => {
        const n = normalizeToCanonicalDocument(stripRequirementParentheticals(x.name) || x.name);
        return { ...x, name: n.title };
      }),
    managerMustProvide: structured.managerMustProvide
      .filter((x) => !isNonResidentOnlyRequirement(x))
      .map((x) => {
        const n = normalizeToCanonicalDocument(stripRequirementParentheticals(x.name) || x.name);
        return { ...x, name: n.title };
      }),
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
    if (isNonResidentOnlyRequirement(x)) continue;
    const cleanName = stripRequirementParentheticals(x.name) || x.name;
    const n = normalizeToCanonicalDocument(cleanName);
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
 */
export function buildRequiredDocumentsList(structured) {
  const lena = normalizeItemList("lena", structured.lenaCanPrepare);
  const mgr = normalizeItemList("manager", structured.managerMustProvide);
  /** @type {Map<string, NormalizedDoc>} */
  const all = new Map();
  for (const d of [...lena, ...mgr]) {
    const key = d.id !== "other" ? d.id : `other:${d.rawName}`;
    if (!all.has(key)) all.set(key, d);
  }
  let list = sortSubmissionDocuments([...all.values()]);
  if (!list.some((d) => d.id === "commercial_proposal")) {
    list = [
      { ...normalizeToCanonicalDocument("Коммерческое предложение"), source: "lena" },
      ...list,
    ];
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
 * @param {AnalysisStructured} structured
 * @param {NormalizedDoc[]} requiredDocuments
 * @param {string | undefined} inputsFolderWebViewLink
 */
export function formatDocumentCompositionStep1Telegram(
  _structured,
  requiredDocuments,
  inputsFolderWebViewLink,
) {
  const docsLink = inputsFolderWebViewLink?.trim();
  const lines = [
    docsLink
      ? `**Документы заказчика:** ${docsLink}`
      : "**Документы заказчика:** — _(папка inputs на Drive)_",
    "",
    "**К подаче:**",
  ];
  if (!requiredDocuments.length) {
    lines.push("- _(в КД не выделены документы с цитатой — проверьте парсинг.)_");
  } else {
    for (const d of requiredDocuments) {
      lines.push(`- ${submissionDisplayTitle(d)}`);
    }
  }
  return lines.join("\n");
}

/**
 * @param {AnalysisStructured} structured
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {string} orgLabel
 * @param {NormalizedDoc[]} lenaPrepare
 * @param {import("./ensureDocumentUploadTargets.js").DocumentUploadTarget[]} uploadTargets
 */
export function formatRefinedChecklistStep2Telegram(
  structured,
  offerOrg,
  orgLabel,
  lenaPrepare,
  uploadTargets,
) {
  const title = structured.tenderTitle?.trim() || "Закупка";
  const linkById = new Map(uploadTargets.map((t) => [t.docId, t.webViewLink]));

  const lines = [`**${title}**`, `Участник: **${orgLabel}**`, "", "**Подготовлю сама:**"];
  if (!lenaPrepare.length) {
    lines.push("- _(нет пунктов с опорой в КД — уточните по документам.)_");
  } else {
    for (const d of lenaPrepare) {
      lines.push(`- ${submissionDisplayTitle(d)}`);
    }
  }

  lines.push("", "**Требует догрузки:**");
  if (!uploadTargets.length) {
    lines.push("- _(нет — переходите к условиям.)_");
  } else {
    for (const t of uploadTargets) {
      const link = linkById.get(t.docId) ?? t.webViewLink;
      lines.push(`- ${t.title} — [загрузить](${link})`);
    }
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
 */
export async function buildRefinedChecklistTelegramBundle(
  userRootId,
  tenderId,
  offerOrg,
  orgLabel,
  structured,
  requiredDocuments,
  treeOpts,
) {
  const { lenaPrepare, managerUpload } = buildRefinedChecklist(requiredDocuments, offerOrg, structured);
  const uploadTargets = await ensureDocumentUploadTargets(
    userRootId,
    tenderId,
    offerOrg,
    managerUpload.map((d) => ({ id: d.id, title: d.title, storage: d.storage })),
    treeOpts,
  );
  const text = formatRefinedChecklistStep2Telegram(
    structured,
    offerOrg,
    orgLabel,
    lenaPrepare,
    uploadTargets,
  );
  return { text, lenaPrepare, managerUpload, uploadTargets };
}
