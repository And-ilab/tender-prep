import { listChildren } from "../drive/ops.js";
import { resolveCompanyMasterFolderIds } from "./companyDocsIndex.js";
import { extractAndIdentifyDriveFile } from "./identifyUploadedDocuments.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * @typedef {Object} ReferenceCandidate
 * @property {string} fileId
 * @property {string} fileName
 * @property {number} score
 * @property {string | null} customerHint
 * @property {string | null} yearHint
 */

/**
 * @param {string} text
 * @param {string} fileName
 */
function scoreReferenceAgainstRequirements(text, fileName, requirements) {
  const blob = `${fileName}\n${text}`.toLowerCase();
  let score = 0;
  if (/отзыв|референс|reference|договор|контракт/i.test(blob)) score += 5;
  for (const req of requirements) {
    const r = String(req?.description ?? req?.summary ?? req ?? "").toLowerCase();
    if (r.length < 4) continue;
    const tokens = r.split(/\s+/).filter((t) => t.length >= 5);
    for (const t of tokens.slice(0, 8)) {
      if (blob.includes(t)) score += 2;
    }
  }
  const year = blob.match(/\b(20\d{2})\b/);
  return { score, yearHint: year?.[1] ?? null };
}

/**
 * @param {import("./documentChecklist.js").AnalysisStructured} structured
 * @returns {number}
 */
function requiredReferenceCount(structured) {
  const reqs = structured.qualificationRequirements ?? [];
  for (const r of reqs) {
    const s = String(r?.description ?? r?.summary ?? r ?? "").toLowerCase();
    const m = s.match(/(\d+)\s*(?:отзыв|референс|договор|контракт)/);
    if (m) return Math.max(1, Number(m[1]));
  }
  return 1;
}

/**
 * @param {string} userRootId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {import("./documentChecklist.js").AnalysisStructured} structured
 * @param {import("./companyDocsIndex.js").CompanyDocsIndex} index
 */
export async function selectReferenceFilesForQualification(userRootId, offerOrg, structured, index) {
  const folders = await resolveCompanyMasterFolderIds(userRootId, offerOrg);
  const poolIds = new Set(
    index.files.filter((e) => e.canonicalId === "reference_list").map((e) => e.fileId),
  );

  /** @type {ReferenceCandidate[]} */
  const candidates = [];
  if (folders.referencesFolderId) {
    const files = await listChildren(folders.referencesFolderId);
    for (const f of files) {
      if (f.mimeType === FOLDER_MIME) continue;
      const fileId = String(f.id ?? "");
      const fileName = String(f.name ?? "");
      if (!fileId) continue;
      const indexed = index.files.find((e) => e.fileId === fileId);
      if (indexed && indexed.qualificationStatus === "rejected") continue;
      const identified = indexed
        ? {
            fileId,
            fileName,
            canonicalId: indexed.canonicalId,
            title: null,
            documentDateIso: indexed.documentDateIso ?? null,
            reportingPeriod: indexed.reportingPeriod ?? null,
            needsReview: indexed.needsReview ?? false,
          }
        : await extractAndIdentifyDriveFile(fileId, fileName, f.mimeType, {
            scopeIds: ["reference_list"],
          });
      const { score, yearHint } = scoreReferenceAgainstRequirements(
        fileName,
        fileName,
        structured.qualificationRequirements ?? [],
      );
      candidates.push({
        fileId,
        fileName,
        score: score + (poolIds.has(fileId) ? 3 : 0),
        customerHint: null,
        yearHint,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const need = requiredReferenceCount(structured);
  const selected = candidates.slice(0, need);
  const missing = Math.max(0, need - selected.length);

  return { selected, missing, requiredCount: need };
}
