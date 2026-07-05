import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG } from "../drive/layoutConstants.js";
import {
  computeBankReferenceMaxDateIso,
  extractPoaExpiryDateIso,
  findMatchingDriveFile,
  isBankReferenceDateValid,
  listCompanySubfolderFiles,
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

  it("findMatchingDriveFile matches short certificate filename via normalize", () => {
    const hit = findMatchingDriveFile([{ id: "9", name: "Свидетельство.pdf" }], "state_registration_certificate");
    assert.ok(hit);
    assert.equal(hit.id, "9");
  });

  it("findMatchingDriveFile matches abbreviated гос регистрации certificate filename", () => {
    const hit = findMatchingDriveFile(
      [{ id: "10", name: "Свидетельство о гос регистрации (2).pdf" }],
      "state_registration_certificate",
    );
    assert.ok(hit);
    assert.equal(hit.id, "10");
  });

  it("findMatchingDriveFile matches short bank reference filename справка 1.10.pdf", () => {
    const hit = findMatchingDriveFile([{ id: "11", name: "справка 1.10.pdf" }], "bank_reference");
    assert.ok(hit);
    assert.equal(hit.id, "11");
  });

  it("findMatchingDriveFile does not match TPP certificate as bank_reference", () => {
    const hit = findMatchingDriveFile(
      [{ id: "12", name: "справка ТПП происхождение.pdf" }],
      "bank_reference",
    );
    assert.equal(hit, null);
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

  it("company subfolders are distinct for gs-retail vs finselvat", () => {
    assert.notEqual(
      LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG.gs_retail,
      LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG.finselvat,
    );
    assert.equal(LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG.gs_retail, "gs-retail");
    assert.equal(LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG.finselvat, "finselvat");
  });

  it("extractPoaExpiryDateIso parses действует до", () => {
    assert.equal(extractPoaExpiryDateIso("действует до 31.12.2026"), "2026-12-31");
  });

  it("listCompanySubfolderFiles is exported for strict company isolation", () => {
    assert.equal(typeof listCompanySubfolderFiles, "function");
  });
});
