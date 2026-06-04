/**
 * Эталонные типы документов для чеклиста после Analysis (Telegram).
 * Добавляйте новые записи в CANONICAL_DOCUMENT_TYPES и синонимы.
 */

/** @typedef {"founding" | "org" | "tender"} DocumentStorage */
/** @typedef {"lena" | "manager"} DocumentPreparedBy */

/**
 * @typedef {Object} CanonicalDocumentType
 * @property {string} id
 * @property {string} title
 * @property {string[]} synonyms
 * @property {DocumentStorage} storage
 * @property {DocumentPreparedBy} preparedByDefault
 */

/** @type {CanonicalDocumentType[]} */
export const CANONICAL_DOCUMENT_TYPES = [
  {
    id: "commercial_proposal",
    title: "Коммерческое предложение",
    synonyms: ["коммерческое предложение", "коммерческого предложения", "кп", "ценовое предложение"],
    storage: "tender",
    preparedByDefault: "lena",
  },
  {
    id: "technical_proposal",
    title: "Техническое предложение",
    synonyms: ["техническое предложение", "технического предложения", "техпредложение"],
    storage: "tender",
    preparedByDefault: "lena",
  },
  {
    id: "application_form",
    title: "Заявка на участие",
    synonyms: ["заявка на участие", "заявка участника", "форма заявки"],
    storage: "tender",
    preparedByDefault: "lena",
  },
  {
    id: "budget_debt_statement",
    title: "Заявление об отсутствии задолженности по платежам в бюджет",
    synonyms: [
      "заявление об отсутствии задолженности",
      "отсутствии задолженности по платежам",
      "задолженности по платежам в бюджет",
      "задолженность по платежам",
    ],
    storage: "tender",
    preparedByDefault: "lena",
  },
  {
    id: "written_consent_contract",
    title: "Письменное согласие заключить договор",
    synonyms: [
      "письменное согласие",
      "согласие заключить договор",
      "согласие на условиях задания",
      "согласие заключить договор на условиях",
    ],
    storage: "tender",
    preparedByDefault: "lena",
  },
  {
    id: "bank_reference",
    title: "Справка из банка",
    synonyms: ["справка из банка", "справка банка", "банковская справка", "банковская выписка"],
    storage: "org",
    preparedByDefault: "manager",
  },
  {
    id: "reliability_letter",
    title: "Письмо о благонадёжности",
    synonyms: ["благонадежност", "благонадёжност", "письмо о благонад"],
    storage: "org",
    preparedByDefault: "manager",
  },
  {
    id: "balance_sheet",
    title: "Баланс",
    synonyms: ["баланс", "бухгалтерский баланс", "форма 1"],
    storage: "org",
    preparedByDefault: "manager",
  },
  {
    id: "income_statement",
    title: "Отчёт о финансовых результатах (ОФР)",
    synonyms: ["офр", "отчет о финансовых", "отчёт о финансовых", "форма 2"],
    storage: "org",
    preparedByDefault: "manager",
  },
  {
    id: "egr_extract",
    title: "Выписка из торгового реестра",
    synonyms: ["выписка из торгового реестра", "торговый реестр", "егр", "выписка егр"],
    storage: "founding",
    preparedByDefault: "manager",
  },
  {
    id: "charter",
    title: "Устав",
    synonyms: ["устав", "учредительн"],
    storage: "founding",
    preparedByDefault: "manager",
  },
  {
    id: "founding_documents",
    title: "Учредительные документы",
    synonyms: ["учредительные документы", "учредительн"],
    storage: "founding",
    preparedByDefault: "manager",
  },
  {
    id: "power_of_attorney",
    title: "Доверенность на подачу",
    synonyms: ["доверенност", "представител"],
    storage: "tender",
    preparedByDefault: "manager",
  },
  {
    id: "reference_list",
    title: "Референс-лист",
    synonyms: ["референс", "опыт выполнен", "аналогичн"],
    storage: "tender",
    preparedByDefault: "manager",
  },
  {
    id: "warranty_letter",
    title: "Гарантийные обязательства",
    synonyms: ["гарантийн", "гарантия"],
    storage: "tender",
    preparedByDefault: "lena",
  },
  {
    id: "payment_terms",
    title: "Условия оплаты",
    synonyms: ["условия оплат", "порядок платеж", "график оплат"],
    storage: "tender",
    preparedByDefault: "lena",
  },
];

const BY_ID = new Map(CANONICAL_DOCUMENT_TYPES.map((d) => [d.id, d]));

/**
 * @param {string} raw
 * @returns {{ id: string, title: string, storage: DocumentStorage, preparedByDefault: DocumentPreparedBy, confidence: "high" | "low", rawName: string }}
 */
export function normalizeToCanonicalDocument(raw) {
  const rawName = String(raw ?? "").trim();
  const low = rawName.toLowerCase().replace(/\s+/g, " ");
  if (!low) {
    return {
      id: "other",
      title: "—",
      storage: "tender",
      preparedByDefault: "manager",
      confidence: "low",
      rawName,
    };
  }

  let best = /** @type {CanonicalDocumentType | null} */ (null);
  let bestScore = 0;
  for (const doc of CANONICAL_DOCUMENT_TYPES) {
    for (const syn of doc.synonyms) {
      const s = syn.toLowerCase();
      if (low.includes(s) || s.includes(low.slice(0, Math.min(low.length, 24)))) {
        const score = s.length;
        if (score > bestScore) {
          bestScore = score;
          best = doc;
        }
      }
    }
    if (low.includes(doc.title.toLowerCase())) {
      const score = doc.title.length + 2;
      if (score > bestScore) {
        bestScore = score;
        best = doc;
      }
    }
  }

  if (best) {
    return {
      id: best.id,
      title: best.title,
      storage: best.storage,
      preparedByDefault: best.preparedByDefault,
      confidence: "high",
      rawName,
    };
  }

  const clipped = rawName.length > 80 ? `${rawName.slice(0, 77)}…` : rawName;
  return {
    id: "other",
    title: clipped,
    storage: "tender",
    preparedByDefault: "manager",
    confidence: "low",
    rawName,
  };
}

/**
 * @param {string} id
 * @returns {CanonicalDocumentType | undefined}
 */
export function getCanonicalTypeById(id) {
  return BY_ID.get(id);
}

/**
 * Краткий перечень эталонных названий для system prompt Analysis.
 * @returns {string}
 */
export function canonicalTitlesForAnalysisPrompt() {
  return CANONICAL_DOCUMENT_TYPES.map((d) => d.title).join("; ");
}
