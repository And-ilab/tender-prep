import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeArchiveDocumentText,
  buildStructureProfile,
  classifyFromContent,
} from "./analyzeArchiveDocumentContent.js";
import { archiveFormCanonicalScopeIds } from "../drive/archiveDocumentsIndex.js";

const RELIABILITY_BODY = `
ПИСЬМО О БЛАГОНАДЁЖНОСТИ УЧАСТНИКА ЗАКУПКИ

Настоящим подтверждаем благонадёжность участника закупки и отсутствие
оснований для отказа в допуске к процедуре.

Подпись _________________
м.п.
`.trim();

const APPLICATION_BODY = `
ЗАЯВКА НА УЧАСТИЕ В ЗАКУПКЕ

1. Сведения об участнике закупки
Наименование: (наименование)
Реквизиты участника: _________________________

Подпись _________________
`.trim();

describe("analyzeArchiveDocumentContent", () => {
  it("classifyFromContent detects reliability_letter from body only (not filename)", () => {
    const scopeIds = archiveFormCanonicalScopeIds();
    const result = classifyFromContent(RELIABILITY_BODY, scopeIds);
    assert.equal(result.identifyMethod, "content");
    assert.equal(result.canonicalId, "reliability_letter");
    assert.equal(result.needsReview, false);
    assert.ok(result.textLength > 40);
    assert.ok(result.structureProfile.hasSignatureBlock);
    assert.ok(result.structureProfile.matchedPhrases.some((p) => /благонад/i.test(p)));
  });

  it("analyzeArchiveDocumentText ignores misleading filename context", () => {
    const scopeIds = archiveFormCanonicalScopeIds();
    const result = analyzeArchiveDocumentText(APPLICATION_BODY, scopeIds);
    assert.equal(result.canonicalId, "application_form");
    assert.equal(result.needsReview, false);
    assert.ok(result.structureProfile.hasFormFields);
  });

  it("buildStructureProfile extracts headings and table hints", () => {
    const profile = buildStructureProfile(
      "КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ\n1. Цены\nнаименование\tколичество\tцена",
      archiveFormCanonicalScopeIds(),
    );
    assert.ok(profile.headings.length >= 1);
    assert.equal(profile.hasTable, true);
  });

  it("short text returns needsReview without canonicalId", () => {
    const result = classifyFromContent("короткий текст", archiveFormCanonicalScopeIds());
    assert.equal(result.canonicalId, null);
    assert.equal(result.needsReview, true);
    assert.equal(result.identifyMethod, "none");
  });
});
