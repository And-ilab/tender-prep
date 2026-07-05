import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTextToCanonicalId,
  computeLastReportingQuarterHint,
  extractReportingPeriod,
  isReportingPeriodValid,
} from "./identifyUploadedDocuments.js";

describe("identifyUploadedDocuments", () => {
  it("extractReportingPeriod parses quarter phrases", () => {
    assert.equal(extractReportingPeriod("Баланс за IV квартал 2025"), "2025-Q4");
    assert.equal(extractReportingPeriod("за 3 квартал 2024"), "2024-Q3");
    assert.equal(extractReportingPeriod("2025-Q1"), "2025-Q1");
  });

  it("classifyTextToCanonicalId detects balance sheet from text", () => {
    const hit = classifyTextToCanonicalId("Бухгалтерский баланс форма 1", "scan.pdf");
    assert.ok(hit);
    assert.equal(hit.canonicalId, "balance_sheet");
  });

  it("classifyTextToCanonicalId textOnly ignores misleading filename", () => {
    const hit = classifyTextToCanonicalId(
      "Письмо о благонадёжности участника закупки. Подпись директора.",
      "totally-unrelated.docx",
      ["reliability_letter"],
      { includeTenderTypes: true, textOnly: true },
    );
    assert.ok(hit);
    assert.equal(hit.canonicalId, "reliability_letter");
  });

  it("computeLastReportingQuarterHint uses submission deadline", () => {
    assert.equal(computeLastReportingQuarterHint("15.04.2026"), "2026-Q1");
    assert.equal(computeLastReportingQuarterHint("10.01.2026"), "2025-Q4");
  });

  it("isReportingPeriodValid matches expected quarter", () => {
    assert.equal(isReportingPeriodValid("2026-Q1", "2026-Q1", null), true);
    assert.equal(isReportingPeriodValid("2025-Q4", "2026-Q1", null), false);
  });
});
