/**
 * Распознавание сценариев получения конкурсных документов у заказчика (IceTrade).
 */

const SNAPSHOT_ARTIFACT_NAMES = new Set([
  "icetrade-import-snapshot.json",
  "extract-manifest.json",
  "tender-pipeline-state.json",
  "ai-text-sources.md",
]);

const POSITIVE_REQUEST_MARKERS = [
  /письменн\w*\s+запрос/i,
  /по\s+электронн\w*\s+почт/i,
  /нарочн\w*\s+способ/i,
  /выда\w*[\s\S]{0,120}при\s+условии\s+поступлен/i,
  /запрос\w*\s+на\s+получен/i,
  /при\s+условии\s+поступлен\w*[\s\S]{0,80}запрос/i,
];

const NEGATIVE_ONLY_MARKERS = [
  /размещен\w*\s+на\s+сайт/i,
  /скачать\s+с\s+сайт/i,
  /доступн\w*\s+на\s+сайт/i,
  /без\s+запрос\w*\s+участник/i,
];

const SAMPLE_FILE_PATTERNS = [
  /образец/i,
  /заявлен\w*[\s\S]{0,40}(?:получен|предоставлен)/i,
  /запрос\w*[\s\S]{0,40}(?:документ|конкурсн|тендерн)/i,
  /сопроводит\w*[\s\S]{0,40}(?:документ|получен|предоставлен)/i,
];

const FULL_DOC_PATTERNS = [
  /извещени/i,
  /конкурсн\w*[\s\S]{0,20}документ/i,
  /техническ\w*[\s\S]{0,20}задани/i,
  /\bтз\b/i,
  /проект\w*[\s\S]{0,20}договор/i,
  /договор\w*[\s\S]{0,20}(?:закуп|постав)/i,
  /положени\w*[\s\S]{0,20}о\s+закупк/i,
];

/**
 * @param {string} name
 */
export function isSnapshotArtifactFileName(name) {
  const base = String(name || "")
    .trim()
    .split(/[/\\]/)
    .pop()
    ?.toLowerCase();
  if (!base) return true;
  return SNAPSHOT_ARTIFACT_NAMES.has(base);
}

/**
 * @param {unknown} snap
 * @returns {string}
 */
export function extractProvisionTermsText(snap) {
  if (!snap || typeof snap !== "object") return "";
  const o = /** @type {Record<string, unknown>} */ (snap);
  const st =
    o.structured && typeof o.structured === "object"
      ? /** @type {Record<string, unknown>} */ (o.structured)
      : null;
  const comp =
    st?.competitiveDocuments && typeof st.competitiveDocuments === "object"
      ? /** @type {Record<string, unknown>} */ (st.competitiveDocuments)
      : null;
  const fromStruct =
    typeof comp?.provisionTerms === "string" ? comp.provisionTerms.trim() : "";
  if (fromStruct) return fromStruct;

  const labeled =
    o.labeledFields && typeof o.labeledFields === "object"
      ? /** @type {Record<string, string>} */ (o.labeledFields)
      : null;
  if (labeled) {
    for (const [k, val] of Object.entries(labeled)) {
      const kl = k.toLowerCase();
      if (
        /конкурсн/.test(kl) &&
        /документ/.test(kl) &&
        /(?:предоставлен|выдач|получен|порядок|срок)/.test(kl) &&
        val?.trim()
      ) {
        return val.trim();
      }
    }
  }
  return "";
}

/**
 * @param {string} text
 */
function textRequiresCustomerRequest(text) {
  const t = String(text || "").trim();
  if (t.length < 20) return false;
  const hasPositive = POSITIVE_REQUEST_MARKERS.some((re) => re.test(t));
  if (!hasPositive) return false;
  const negativeOnly = NEGATIVE_ONLY_MARKERS.some((re) => re.test(t));
  if (negativeOnly && !hasPositive) return false;
  return true;
}

/**
 * @param {unknown} snap
 */
export function cardRequiresCustomerRequest(snap) {
  const text = extractProvisionTermsText(snap);
  return textRequiresCustomerRequest(text);
}

/**
 * @param {string} text
 * @param {string[]} [emails]
 * @returns {"email" | "in_person" | "unknown"}
 */
export function pickProvisionMethod(text, emails = []) {
  const t = String(text || "");
  const emailInText = /[a-z0-9._%+-]+@[a-z0-9][a-z0-9.-]+\.[a-z]{2,}/i.exec(t);
  if (emailInText) return "email";
  if (emails.length > 0 && /(?:электронн\w*\s+почт|e-mail|email|@\s)/i.test(t)) return "email";
  if (/нарочн|лично|представител|при\s+посещени/i.test(t)) return "in_person";
  return "unknown";
}

/**
 * @param {string} text
 * @param {string[]} [emails]
 */
export function pickProvisionEmail(text, emails = []) {
  const t = String(text || "");
  const m = /[a-z0-9._%+-]+@[a-z0-9][a-z0-9.-]+\.[a-z]{2,}/i.exec(t);
  if (m) return m[0].toLowerCase();
  if (emails.length === 1) return emails[0].toLowerCase();
  if (emails.length > 1 && /(?:электронн\w*\s+почт|e-mail|email)/i.test(t)) {
    return emails[0].toLowerCase();
  }
  return null;
}

/**
 * @param {string} name
 */
function isSampleFileName(name) {
  const n = String(name || "").trim();
  if (!n) return false;
  return SAMPLE_FILE_PATTERNS.some((re) => re.test(n));
}

/**
 * @param {string} name
 */
function isFullDocFileName(name) {
  const n = String(name || "").trim();
  if (!n) return false;
  return FULL_DOC_PATTERNS.some((re) => re.test(n));
}

/**
 * @param {string[]} fileNames
 * @returns {"empty" | "sample_only" | "full_documentation"}
 */
export function classifyInputAttachmentSet(fileNames) {
  const meaningful = (fileNames ?? [])
    .map((n) => String(n || "").trim())
    .filter((n) => n.length > 0 && !isSnapshotArtifactFileName(n));

  if (meaningful.length === 0) return "empty";

  const sampleHits = meaningful.filter(isSampleFileName);
  const fullHits = meaningful.filter(isFullDocFileName);

  if (fullHits.length > 0 && sampleHits.length < meaningful.length) {
    return "full_documentation";
  }
  if (meaningful.length >= 2 && fullHits.length === 0 && sampleHits.length === 0) {
    return "full_documentation";
  }
  if (sampleHits.length > 0 && fullHits.length === 0) {
    return sampleHits.length === meaningful.length ? "sample_only" : "full_documentation";
  }
  if (meaningful.length >= 2) return "full_documentation";
  if (sampleHits.length === 1 && meaningful.length === 1) return "sample_only";
  return "full_documentation";
}

/**
 * @param {{
 *   method?: "email" | "in_person" | "unknown",
 *   email?: string | null,
 *   inputsFolderWebViewLink?: string,
 * }} p
 * @returns {string}
 */
export function formatCustomerDocRequestMessage(p) {
  const link = p.inputsFolderWebViewLink?.trim();
  const linkLine = link ? `\n\n**Загрузите комплект в inputs:** ${link}` : "";

  if (p.method === "email" && p.email) {
    return [
      "**Конкурсные документы у заказчика** (на IceTrade полного комплекта нет).",
      "",
      `Отправьте **письменный запрос** (PDF) на **${p.email}**; укажите email для ответа и подтвердите получение документов.`,
      linkLine,
      "",
      "После загрузки на Drive нажмите **«Документы загружены»**.",
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (p.method === "in_person") {
    return [
      "**Конкурсные документы у заказчика** (на IceTrade полного комплекта нет).",
      "",
      "Нужен **письменный запрос** и получение комплекта **лично в офисе заказчика**.",
      linkLine,
      "",
      "После загрузки на Drive нажмите **«Документы загружены»**.",
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return [
    "**Конкурсные документы выдаются только по запросу заказчику** (см. карточку IceTrade).",
    linkLine,
    "",
    "После загрузки на Drive нажмите **«Документы загружены»**.",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * @typedef {"block_analyze" | "continue_analyze" | "normal"} ImportProvisionAction
 * @typedef {"show_request_and_wait" | "normal" | null} PostExtractProvisionAction
 * @typedef {{
 *   cardRequiresRequest: boolean,
 *   attachmentClass: "empty" | "sample_only" | "full_documentation",
 *   importAction: ImportProvisionAction,
 *   postExtractAction: PostExtractProvisionAction,
 *   message: string | null,
 *   method: "email" | "in_person" | "unknown",
 *   email: string | null,
 *   provisionTermsText: string,
 * }} ProvisionGate
 */

/**
 * @param {{
 *   snap?: unknown,
 *   uploadedNames?: string[],
 *   inputsFolderWebViewLink?: string,
 * }} p
 * @returns {ProvisionGate}
 */
export function resolveProvisionGate(p) {
  const snap = p.snap;
  const uploadedNames = p.uploadedNames ?? [];
  const provisionTermsText = extractProvisionTermsText(snap);
  const cardRequiresRequest = textRequiresCustomerRequest(provisionTermsText);
  const attachmentClass = classifyInputAttachmentSet(uploadedNames);

  const emails =
    snap && typeof snap === "object" && Array.isArray(/** @type {Record<string, unknown>} */ (snap).emails)
      ? /** @type {string[]} */ (/** @type {Record<string, unknown>} */ (snap).emails).map((e) => String(e))
      : [];
  const method = pickProvisionMethod(provisionTermsText, emails);
  const email = pickProvisionEmail(provisionTermsText, emails);

  /** @type {ImportProvisionAction} */
  let importAction = "normal";
  /** @type {PostExtractProvisionAction} */
  let postExtractAction = null;
  /** @type {string | null} */
  let message = null;

  if (cardRequiresRequest) {
    if (attachmentClass === "empty") {
      importAction = "block_analyze";
      postExtractAction = null;
      message = formatCustomerDocRequestMessage({
        method,
        email,
        inputsFolderWebViewLink: p.inputsFolderWebViewLink,
      });
    } else {
      importAction = "continue_analyze";
      if (attachmentClass === "sample_only") {
        postExtractAction = "show_request_and_wait";
        message = formatCustomerDocRequestMessage({
          method,
          email,
          inputsFolderWebViewLink: p.inputsFolderWebViewLink,
        });
      } else {
        postExtractAction = "normal";
      }
    }
  } else {
    importAction = "normal";
    postExtractAction = null;
  }

  return {
    cardRequiresRequest,
    attachmentClass,
    importAction,
    postExtractAction,
    message,
    method,
    email,
    provisionTermsText,
  };
}

/**
 * После extract: пересчитать gate по актуальным именам файлов.
 * @param {{
 *   snap?: unknown,
 *   fileNames?: string[],
 *   inputsFolderWebViewLink?: string,
 * }} p
 */
export function resolvePostExtractProvisionGate(p) {
  const gate = resolveProvisionGate({
    snap: p.snap,
    uploadedNames: p.fileNames ?? [],
    inputsFolderWebViewLink: p.inputsFolderWebViewLink,
  });
  if (!gate.cardRequiresRequest) {
    return { ...gate, postExtractAction: "normal", message: null };
  }
  if (gate.attachmentClass === "sample_only") {
    return {
      ...gate,
      postExtractAction: "show_request_and_wait",
      message: formatCustomerDocRequestMessage({
        method: gate.method,
        email: gate.email,
        inputsFolderWebViewLink: p.inputsFolderWebViewLink,
      }),
    };
  }
  return { ...gate, postExtractAction: "normal", message: null };
}
