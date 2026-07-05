import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TENDER_DOCUMENT_FORMATTING_SPEC,
  TENDER_DOCUMENT_FORMATTING_SECTION_HEADER,
  buildTenderDocumentFormattingPromptSection,
} from "./tenderDocumentFormattingPrompt.js";

describe("tenderDocumentFormattingPrompt", () => {
  it("buildTenderDocumentFormattingPromptSection includes header and all seven sections", () => {
    const section = buildTenderDocumentFormattingPromptSection();
    assert.match(section, new RegExp(TENDER_DOCUMENT_FORMATTING_SECTION_HEADER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(section, /Times New Roman, размер 14/);
    assert.match(section, /7\. Нумерация страниц/);
    assert.ok(section.startsWith(TENDER_DOCUMENT_FORMATTING_SECTION_HEADER));
    assert.ok(section.includes(TENDER_DOCUMENT_FORMATTING_SPEC));
  });

  it("omits header when includeHeader is false", () => {
    const section = buildTenderDocumentFormattingPromptSection({ includeHeader: false });
    assert.equal(section, TENDER_DOCUMENT_FORMATTING_SPEC);
    assert.doesNotMatch(section, /## Оформление документов/);
  });
});
