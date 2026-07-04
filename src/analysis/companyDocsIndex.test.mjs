import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertIndexCompanyMatch,
  emptyCompanyDocsIndex,
  pickBestFileForCanonicalId,
  upsertIndexEntry,
} from "./companyDocsIndex.js";

describe("companyDocsIndex", () => {
  it("pickBestFileForCanonicalId prefers valid and newer date", () => {
    const entries = [
      {
        fileId: "a",
        canonicalId: "bank_reference",
        masterPath: "org-docs",
        fileName: "old.pdf",
        documentDateIso: "2025-01-01",
        identifiedAt: "2026-01-01",
        qualificationStatus: "needsReview",
      },
      {
        fileId: "b",
        canonicalId: "bank_reference",
        masterPath: "org-docs",
        fileName: "new.pdf",
        documentDateIso: "2026-06-01",
        identifiedAt: "2026-06-01",
        qualificationStatus: "valid",
      },
    ];
    const best = pickBestFileForCanonicalId(entries, "bank_reference");
    assert.equal(best?.fileId, "b");
  });

  it("assertIndexCompanyMatch rejects wrong company", () => {
    assert.throws(() =>
      assertIndexCompanyMatch({ company: "finselvat", files: [], version: 1, updatedAt: "" }, "gs_retail"),
    );
  });

  it("upsertIndexEntry replaces same fileId", () => {
    const index = emptyCompanyDocsIndex("gs_retail");
    upsertIndexEntry(index, {
      fileId: "1",
      canonicalId: "charter",
      masterPath: "founding-docs",
      fileName: "a.pdf",
      identifiedAt: "t1",
    });
    upsertIndexEntry(index, {
      fileId: "1",
      canonicalId: "charter",
      masterPath: "founding-docs",
      fileName: "b.pdf",
      identifiedAt: "t2",
    });
    assert.equal(index.files.length, 1);
    assert.equal(index.files[0].fileName, "b.pdf");
  });
});
