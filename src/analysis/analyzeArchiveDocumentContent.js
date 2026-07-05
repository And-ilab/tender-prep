import { CANONICAL_DOCUMENT_TYPES } from "./canonicalDocumentTypes.js";
import { classifyTextToCanonicalId } from "./identifyUploadedDocuments.js";

export const ARCHIVE_CONTENT_SNIPPET_LEN = 800;
export const ARCHIVE_CONTENT_CLASSIFY_THRESHOLD = 18;

/**
 * @typedef {Object} ArchiveStructureProfile
 * @property {string} titleBlock
 * @property {string[]} headings
 * @property {boolean} hasTable
 * @property {boolean} hasSignatureBlock
 * @property {boolean} hasFormFields
 * @property {string[]} matchedPhrases
 */

/**
 * @param {string} text
 * @param {string[]} [scopeIds]
 * @returns {ArchiveStructureProfile}
 */
export function buildStructureProfile(text, scopeIds = []) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").trim();
  const lines = normalized.split("\n").map((l) => l.trim()).filter(Boolean);
  const titleBlock = lines.slice(0, 5).join("\n").slice(0, 400);

  /** @type {string[]} */
  const headings = [];
  for (const line of lines.slice(0, 80)) {
    if (line.length < 4 || line.length > 200) continue;
    if (/^\d+(?:\.\d+)*[\.)]\s+\S/.test(line)) headings.push(line.slice(0, 120));
    else if (/^[А-ЯA-Z][А-ЯA-Z0-9\s«»\-–—]{6,}$/.test(line)) headings.push(line.slice(0, 120));
    else if (/^(?:заявк\w*|письм\w*|коммерческ\w*\s+предлож|техническ\w*\s+предлож|отзыв|референс)/i.test(line)) {
      headings.push(line.slice(0, 120));
    }
    if (headings.length >= 12) break;
  }

  const blob = normalized.toLowerCase();
  const hasTable =
    /\t/.test(normalized) ||
    /\|.+\|/.test(normalized) ||
    /наименован\w*.*(?:количеств|цена|сумма)/i.test(blob);
  const hasSignatureBlock = /(?:подпис\w*|м\.?\s*п\.?|директор|доверенност)/i.test(blob);
  const hasFormFields =
    /_{3,}/.test(normalized) ||
    /\(наименован\w*\)/i.test(blob) ||
    /реквизит\w*\s+участник/i.test(blob);

  /** @type {string[]} */
  const matchedPhrases = [];
  const ids = scopeIds.length ? scopeIds : CANONICAL_DOCUMENT_TYPES.map((t) => t.id);
  for (const id of ids) {
    const canon = CANONICAL_DOCUMENT_TYPES.find((t) => t.id === id);
    if (!canon) continue;
    for (const syn of [canon.title, ...canon.synonyms]) {
      const s = syn.toLowerCase();
      if (s.length >= 4 && blob.includes(s)) matchedPhrases.push(syn);
    }
  }

  return {
    titleBlock,
    headings: [...new Set(headings)],
    hasTable,
    hasSignatureBlock,
    hasFormFields,
    matchedPhrases: [...new Set(matchedPhrases)].slice(0, 20),
  };
}

/**
 * @param {ArchiveStructureProfile} profile
 * @returns {number}
 */
function structureBonusForType(profile, canonicalId) {
  let bonus = 0;
  if (profile.hasFormFields && ["application_form", "budget_debt_statement", "written_consent_contract"].includes(canonicalId)) {
    bonus += 4;
  }
  if (profile.hasSignatureBlock && ["reliability_letter", "application_form", "power_of_attorney"].includes(canonicalId)) {
    bonus += 3;
  }
  if (profile.hasTable && ["commercial_proposal", "technical_proposal", "tz_compliance_table"].includes(canonicalId)) {
    bonus += 4;
  }
  if (canonicalId === "reference_list" && /отзыв|референс|reference/i.test(profile.matchedPhrases.join(" "))) {
    bonus += 5;
  }
  return bonus;
}

/**
 * @param {string} text
 * @param {string[]} scopeIds
 * @param {ArchiveStructureProfile} [structureProfile]
 * @returns {{
 *   canonicalId: string | null,
 *   title: string | null,
 *   score: number,
 *   needsReview: boolean,
 *   identifyMethod: "content" | "none",
 *   structureProfile: ArchiveStructureProfile,
 *   contentSnippet: string,
 *   textLength: number,
 * }}
 */
export function classifyFromContent(text, scopeIds, structureProfile) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").trim();
  const profile = structureProfile ?? buildStructureProfile(normalized, scopeIds);
  const contentSnippet = normalized.slice(0, ARCHIVE_CONTENT_SNIPPET_LEN);
  const textLength = normalized.length;

  if (!normalized || textLength < 40) {
    return {
      canonicalId: null,
      title: null,
      score: 0,
      needsReview: true,
      identifyMethod: "none",
      structureProfile: profile,
      contentSnippet,
      textLength,
    };
  }

  const hit = classifyTextToCanonicalId(normalized, "", scopeIds, {
    includeTenderTypes: true,
    textOnly: true,
  });

  let score = hit?.score ?? 0;
  if (hit) score += structureBonusForType(profile, hit.canonicalId);

  const confident = hit && score >= ARCHIVE_CONTENT_CLASSIFY_THRESHOLD;

  return {
    canonicalId: confident ? hit.canonicalId : hit?.canonicalId ?? null,
    title: confident ? hit.title : hit?.title ?? null,
    score,
    needsReview: !confident,
    identifyMethod: hit ? "content" : "none",
    structureProfile: profile,
    contentSnippet,
    textLength,
  };
}

/**
 * @param {string} text
 * @param {string[]} scopeIds
 */
export function analyzeArchiveDocumentText(text, scopeIds) {
  const profile = buildStructureProfile(text, scopeIds);
  return classifyFromContent(text, scopeIds, profile);
}
