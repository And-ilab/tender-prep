import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPreparationPromptMarkdown } from "./preparationPromptFromAnalysis.js";

describe("preparationPromptFromAnalysis", () => {
  it("includes cp composition block when cpCompositionRequirements is non-empty", () => {
    const md = buildPreparationPromptMarkdown({
      tenderId: "12345",
      structured: {
        tenderTitle: "Тест",
        sumOrBudget: null,
        submissionOverview: null,
        submissionMethod: null,
        submissionDeadline: null,
        lenaCanPrepare: [],
        managerMustProvide: [],
        cpCompositionRequirements: [
          {
            summary: "Раздел с описанием опыта и референсами",
            evidence: "коммерческое предложение должно содержать описание опыта",
          },
        ],
      },
      corpus: "",
      generatedAtIso: "2026-07-02T00:00:00.000Z",
    });
    assert.match(md, /Состав КП по документам заказчика/);
    assert.match(md, /описание опыта/i);
  });

  it("notes standard org template when cpCompositionRequirements is empty", () => {
    const md = buildPreparationPromptMarkdown({
      tenderId: "12345",
      structured: {
        tenderTitle: null,
        sumOrBudget: null,
        submissionOverview: null,
        submissionMethod: null,
        submissionDeadline: null,
        lenaCanPrepare: [],
        managerMustProvide: [],
        cpCompositionRequirements: [],
      },
      corpus: "",
      generatedAtIso: "2026-07-02T00:00:00.000Z",
    });
    assert.match(md, /Стандартная структура org-шаблона/i);
  });
});
