import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inferArchiveYear,
  pickBestArchiveAnalog,
  scoreArchiveAnalogEntry,
} from "./archiveDocumentsIndex.js";

/**
 * @param {Partial<import("./archiveDocumentsIndex.js").ArchiveDocumentsIndexEntry>} overrides
 * @returns {import("./archiveDocumentsIndex.js").ArchiveDocumentsIndexEntry}
 */
function contentEntry(overrides) {
  return {
    driveFileId: "x",
    fileName: "doc1.docx",
    webViewLink: null,
    drivePath: "A/Предложения/doc1.docx",
    project: "A",
    archiveYear: 2025,
    pathRole: "submission",
    canonicalId: "reliability_letter",
    title: "Письмо о благонадёжности",
    identifyMethod: "content",
    needsReview: false,
    sizeBytes: 20000,
    textLength: 3500,
    modifiedTime: null,
    extractor: "mammoth",
    extractError: null,
    structureProfile: {
      titleBlock: "ПИСЬМО О БЛАГОНАДЁЖНОСТИ",
      headings: ["ПИСЬМО О БЛАГОНАДЁЖНОСТИ"],
      hasTable: false,
      hasSignatureBlock: true,
      hasFormFields: false,
      matchedPhrases: ["благонадёжност"],
    },
    contentSnippet: "ПИСЬМО О БЛАГОНАДЁЖНОСТИ участника",
    classifyScore: 22,
    ...overrides,
  };
}

describe("archiveDocumentsIndex", () => {
  it("inferArchiveYear from root name and path", () => {
    assert.equal(inferArchiveYear("2025"), 2025);
    assert.equal(inferArchiveYear(null, "Проект/2024/Предложения/x.docx"), 2024);
  });

  it("pickBestArchiveAnalog prefers longer text and newer year", () => {
    const entries = [
      contentEntry({
        driveFileId: "1",
        archiveYear: 2024,
        textLength: 1200,
        sizeBytes: 12000,
      }),
      contentEntry({
        driveFileId: "2",
        archiveYear: 2025,
        textLength: 4500,
        sizeBytes: 45000,
        structureProfile: {
          titleBlock: "Полная форма",
          headings: ["1. Реквизиты", "2. Подпись"],
          hasTable: true,
          hasSignatureBlock: true,
          hasFormFields: true,
          matchedPhrases: ["благонадёжност", "участник закупки"],
        },
      }),
    ];
    const picked = pickBestArchiveAnalog(entries, "reliability_letter");
    assert.ok(picked);
    assert.equal(picked.driveFileId, "2");
    assert.ok(
      scoreArchiveAnalogEntry(picked, "reliability_letter") >
        scoreArchiveAnalogEntry(entries[0], "reliability_letter"),
    );
  });

  it("pickBestArchiveAnalog ignores unrelated canonicalId", () => {
    const entries = [
      contentEntry({
        canonicalId: "commercial_proposal",
        title: "Коммерческое предложение",
        structureProfile: {
          titleBlock: "КП",
          headings: [],
          hasTable: true,
          hasSignatureBlock: false,
          hasFormFields: false,
          matchedPhrases: ["коммерческое предложение"],
        },
      }),
    ];
    assert.equal(pickBestArchiveAnalog(entries, "application_form"), null);
  });

  it("pickBestArchiveAnalog penalizes needsReview and empty textLength", () => {
    const entries = [
      contentEntry({
        driveFileId: "1",
        needsReview: true,
        textLength: null,
        classifyScore: 12,
      }),
      contentEntry({
        driveFileId: "2",
        textLength: 2800,
        needsReview: false,
      }),
    ];
    const picked = pickBestArchiveAnalog(entries, "reliability_letter");
    assert.equal(picked?.driveFileId, "2");
  });
});
