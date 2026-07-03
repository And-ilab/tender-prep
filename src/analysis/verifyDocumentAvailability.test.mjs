import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeBankReferenceMaxDateIso,
  findMatchingDriveFile,
  isBankReferenceDateValid,
} from "./verifyDocumentAvailability.js";

describe("verifyDocumentAvailability", () => {
  it("findMatchingDriveFile matches canonical stem or slug prefix", () => {
    const files = [
      { id: "1", name: "random.pdf" },
      { id: "2", name: "Справка_из_банка_2026.pdf" },
      { id: "3", name: "bank_reference__gs.pdf" },
    ];
    const hit = findMatchingDriveFile(files, "bank_reference");
    assert.ok(hit);
    assert.equal(hit.id, "2");
  });

  it("computeBankReferenceMaxDateIso returns first day of previous month", () => {
    assert.equal(computeBankReferenceMaxDateIso("15.03.2026"), "2026-02-01");
    assert.equal(computeBankReferenceMaxDateIso("2026-01-10"), "2025-12-01");
  });

  it("isBankReferenceDateValid compares ISO dates", () => {
    assert.equal(isBankReferenceDateValid("2026-01-15", "2026-02-01"), true);
    assert.equal(isBankReferenceDateValid("2026-03-01", "2026-02-01"), false);
    assert.equal(isBankReferenceDateValid(null, "2026-02-01"), null);
  });
});
