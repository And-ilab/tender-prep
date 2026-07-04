import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateIdentifiedDocument,
  verifyStatusIsValidForPackage,
} from "./validateOrgDocumentRules.js";

describe("validateOrgDocumentRules", () => {
  it("verifyStatusIsValidForPackage rejects unparsed periodic org", () => {
    assert.equal(verifyStatusIsValidForPackage("found_org", "bank_reference"), false);
    assert.equal(verifyStatusIsValidForPackage("found_org_valid", "bank_reference"), true);
    assert.equal(verifyStatusIsValidForPackage("found_founding", "charter"), true);
    assert.equal(verifyStatusIsValidForPackage("found_org", "charter"), true);
  });

  it("validateIdentifiedDocument rejects wrong expected type", () => {
    const r = validateIdentifiedDocument(
      {
        fileId: "1",
        fileName: "x.pdf",
        canonicalId: "charter",
        title: "Устав",
        documentDateIso: null,
        reportingPeriod: null,
        needsReview: false,
      },
      { expectedCanonicalId: "state_registration_certificate" },
    );
    assert.equal(r.status, "rejected");
  });

  it("validateIdentifiedDocument accepts founding certificate", () => {
    const r = validateIdentifiedDocument(
      {
        fileId: "1",
        fileName: "svid.pdf",
        canonicalId: "state_registration_certificate",
        title: "Свидетельство",
        documentDateIso: null,
        reportingPeriod: null,
        needsReview: false,
      },
      {},
    );
    assert.equal(r.status, "valid");
  });

  it("validateIdentifiedDocument rejects expired power of attorney", () => {
    const r = validateIdentifiedDocument(
      {
        fileId: "2",
        fileName: "poa.pdf",
        canonicalId: "power_of_attorney",
        title: "Доверенность",
        documentDateIso: "2026-01-01",
        reportingPeriod: null,
        needsReview: false,
      },
      { structured: { submissionDeadline: "15.03.2026" } },
    );
    assert.equal(r.status, "rejected");
  });
});
