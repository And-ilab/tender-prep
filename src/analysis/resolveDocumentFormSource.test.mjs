import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fileMatchesCanonicalType,
  pickBestCustomerFormFile,
  pickBestTemplateFile,
  scoreCustomerFormFile,
} from "./resolveDocumentFormSource.js";

describe("resolveDocumentFormSource", () => {
  it("matches application form by filename", () => {
    assert.equal(fileMatchesCanonicalType("Приложение_2_форма_заявки.docx", "application_form"), true);
    assert.equal(fileMatchesCanonicalType("icetrade-import-snapshot.json", "application_form"), false);
  });

  it("prefers customer form file with canonical name in inputs", () => {
    const picked = pickBestCustomerFormFile(
      [
        { id: "1", name: "КД.pdf" },
        { id: "2", name: "Приложение_2_форма_заявки.docx" },
      ],
      "application_form",
    );
    assert.ok(picked);
    assert.equal(picked.id, "2");
  });

  it("scores form hint higher than generic doc", () => {
    const scoreForm = scoreCustomerFormFile("форма_заявки_участника.doc", "application_form");
    const scoreOther = scoreCustomerFormFile("договор_поставки.pdf", "application_form");
    assert.ok(scoreForm > scoreOther);
  });

  it("pickBestTemplateFile prefers longer name for most_complete strategy", () => {
    const picked = pickBestTemplateFile(
      [
        { id: "1", name: "budget_debt_statement__short.docx" },
        { id: "2", name: "budget_debt_statement__полная_форма_с_реквизитами.docx" },
      ],
      "budget_debt_statement",
      "most_complete",
    );
    assert.ok(picked);
    assert.equal(picked.id, "2");
  });
});
