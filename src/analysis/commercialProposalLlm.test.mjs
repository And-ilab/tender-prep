import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripCommercialProposalServiceMetadata } from "./commercialProposalLlm.js";

describe("stripCommercialProposalServiceMetadata", () => {
  it("removes block after corpus sources header", () => {
    const input = [
      "**3. Срок действия предложения**",
      "",
      "Предложение действует 60 дней.",
      "",
      "Разделы КП подготовлены на основе следующих файлов корпуса:",
      "",
      "- **Раздел 1 (предмет и объём работ):** zcp.pdf",
    ].join("\n");
    const out = stripCommercialProposalServiceMetadata(input);
    assert.equal(out, "**3. Срок действия предложения**\n\nПредложение действует 60 дней.");
  });

  it("removes trailing corpus trace bullets but keeps real appendix", () => {
    const input = [
      "**Приложение к коммерческому предложению**",
      "",
      "- Заявление о соответствии",
      "- Справка из банка",
      "",
      "- **Раздел 1 (предмет и объём работ):** zcp.pdf (раздел «Требования»)",
      "- **Раздел 2 (стоимость и условия оплаты):** Блок «Согласованная цена и условия (менеджер)»",
    ].join("\n");
    const out = stripCommercialProposalServiceMetadata(input);
    assert.match(out, /Заявление о соответствии/);
    assert.doesNotMatch(out, /Раздел 1 \(предмет/);
    assert.doesNotMatch(out, /Согласованная цена и условия \(менеджер\)/);
  });
});
