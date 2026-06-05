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
  /(?:по|на)\s+электронн\w*\s+почт/i,
  /по\s+электронн\w*\s+почт/i,
  /нарочн\w*\s+способ/i,
  /выда\w*[\s\S]{0,120}при\s+условии\s+поступлен/i,
  /запрос\w*\s+на\s+получен/i,
  /при\s+условии\s+поступлен\w*[\s\S]{0,80}запрос/i,
  /по\s+запрос\w*[\s\S]{0,80}(?:электронн\w*\s+почт|[a-z0-9._%+-]+@)/i,
  /можно\s+получ\w*[\s\S]{0,100}по\s+запрос/i,
  /после\s+получен\w*\s+письменн\w*\s+запрос/i,
  /конкурсн\w*\s+документ\w*[\s\S]{0,160}предоставля\w*[\s\S]{0,100}(?:запрос|почт|@)/i,
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
 * @param {string | null | undefined} raw
 */
function stringField(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * @param {string} kl
 */
function labeledKeyMatchesProvisionTopic(kl) {
  if (/выдач/.test(kl) && /конкурсн/.test(kl)) return true;
  if (/конкурсн/.test(kl) && /документ/.test(kl) && /предостав/.test(kl)) return true;
  if (/конкурсн/.test(kl) && /документ/.test(kl) && /(?:предоставлен|выдач|получен|порядок|срок)/.test(kl)) {
    return true;
  }
  if (/документ/.test(kl) && /техническ/.test(kl)) return true;
  if (/иные\s+сведен/.test(kl)) return true;
  return false;
}

/**
 * @param {string} val
 */
function labeledValueMatchesProvisionTopic(val) {
  const vl = val.toLowerCase();
  if (!/[a-z0-9._%+-]+@/.test(vl)) return false;
  return /(?:по|на)\s+запрос|электронн\w*\s+почт|письменн\w*\s+запрос|можно\s+получ/i.test(vl);
}

/**
 * @param {unknown} snap
 * @returns {string[]}
 */
export function buildProvisionCorpusParts(snap) {
  if (!snap || typeof snap !== "object") return [];
  const o = /** @type {Record<string, unknown>} */ (snap);
  /** @type {string[]} */
  const parts = [];

  const st =
    o.structured && typeof o.structured === "object"
      ? /** @type {Record<string, unknown>} */ (o.structured)
      : null;
  const comp =
    st?.competitiveDocuments && typeof st.competitiveDocuments === "object"
      ? /** @type {Record<string, unknown>} */ (st.competitiveDocuments)
      : null;
  const proc =
    st?.procedure && typeof st.procedure === "object"
      ? /** @type {Record<string, unknown>} */ (st.procedure)
      : null;
  const general =
    st?.general && typeof st.general === "object"
      ? /** @type {Record<string, unknown>} */ (st.general)
      : null;

  for (const raw of [
    comp?.provisionTerms,
    comp?.documentPrice,
    proc?.otherInfo,
    general?.subjectShortDescription,
  ]) {
    const t = stringField(raw);
    if (t) parts.push(t);
  }

  const labeled =
    o.labeledFields && typeof o.labeledFields === "object"
      ? /** @type {Record<string, string>} */ (o.labeledFields)
      : null;
  if (labeled) {
    for (const [k, val] of Object.entries(labeled)) {
      const t = String(val ?? "").trim();
      if (!t) continue;
      const kl = k.toLowerCase();
      if (labeledKeyMatchesProvisionTopic(kl) || labeledValueMatchesProvisionTopic(t)) {
        parts.push(t);
      }
    }
  }

  return parts;
}

/**
 * @param {unknown} snap
 * @returns {string}
 */
export function buildProvisionCorpus(snap) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const part of buildProvisionCorpusParts(snap)) {
    const norm = part.replace(/\s+/g, " ").trim();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out.join("\n\n");
}

/**
 * @param {unknown} snap
 * @returns {string}
 */
export function extractProvisionTermsText(snap) {
  return buildProvisionCorpus(snap);
}

/**
 * @param {string} corpus
 * @param {number} [maxLen]
 */
export function buildProvisionExcerpt(corpus, maxLen = 300) {
  const t = String(corpus || "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const m =
    /(?:выда\w*[\s\S]{0,220}|конкурсн\w*\s+документ\w*[\s\S]{0,220}|можно\s+получ\w*[\s\S]{0,220})/i.exec(t);
  const slice = (m?.[0] ?? t).trim();
  return slice.length > maxLen ? `${slice.slice(0, maxLen)}…` : slice;
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
 * @param {string} corpus
 * @param {string[]} emails
 */
function emptyAttachmentsFallbackRequiresRequest(corpus, emails) {
  const t = String(corpus || "").trim();
  if (t.length < 15) return false;
  const hasEmail = /[a-z0-9._%+-]+@[a-z0-9][a-z0-9.-]+\.[a-z]{2,}/i.test(t) || emails.length > 0;
  if (!hasEmail) return false;
  return /(?:по|на)\s+запрос|электронн\w*\s+почт|письменн\w*\s+запрос|можно\s+получ/i.test(t);
}

/**
 * @param {unknown} snap
 * @param {"empty" | "sample_only" | "full_documentation"} [attachmentClass]
 */
export function cardRequiresCustomerRequest(snap, attachmentClass = "empty") {
  const text = extractProvisionTermsText(snap);
  if (textRequiresCustomerRequest(text)) return true;
  const emails =
    snap && typeof snap === "object" && Array.isArray(/** @type {Record<string, unknown>} */ (snap).emails)
      ? /** @type {string[]} */ (/** @type {Record<string, unknown>} */ (snap).emails).map((e) => String(e))
      : [];
  if (attachmentClass === "empty") {
    return emptyAttachmentsFallbackRequiresRequest(text, emails);
  }
  return false;
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
  if (
    emails.length > 0 &&
    /(?:электронн\w*\s+почт|e-mail|email|(?:по|на)\s+электронн|@)/i.test(t)
  ) {
    return "email";
  }
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
  if (emails.length > 1 && /(?:электронн\w*\s+почт|e-mail|email|(?:по|на)\s+электронн)/i.test(t)) {
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
 *   provisionExcerpt?: string | null,
 * }} p
 * @returns {string}
 */
export function formatCustomerDocRequestMessage(p) {
  const link = p.inputsFolderWebViewLink?.trim();
  const linkLine = link ? `\n\n**Загрузите комплект в inputs:** ${link}` : "";
  const excerptLine = p.provisionExcerpt?.trim()
    ? `\n\n**Порядок выдачи (с карточки):** ${p.provisionExcerpt.trim()}`
    : "";

  if (p.method === "email" && p.email) {
    return [
      "**Конкурсные документы у заказчика** (на IceTrade полного комплекта нет).",
      excerptLine,
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
      excerptLine,
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
    excerptLine,
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
 *   method: "email" | "in_person" | "unknown",
 *   email: string | null,
 *   inputsFolderWebViewLink?: string,
 *   provisionTermsText: string,
 * }} p
 */
function buildGateRequestMessage(p) {
  return formatCustomerDocRequestMessage({
    method: p.method,
    email: p.email,
    inputsFolderWebViewLink: p.inputsFolderWebViewLink,
    provisionExcerpt: buildProvisionExcerpt(p.provisionTermsText),
  });
}

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
  const attachmentClass = classifyInputAttachmentSet(uploadedNames);

  const emails =
    snap && typeof snap === "object" && Array.isArray(/** @type {Record<string, unknown>} */ (snap).emails)
      ? /** @type {string[]} */ (/** @type {Record<string, unknown>} */ (snap).emails).map((e) => String(e))
      : [];
  const cardRequiresRequest = cardRequiresCustomerRequest(snap, attachmentClass);
  const method = pickProvisionMethod(provisionTermsText, emails);
  const email = pickProvisionEmail(provisionTermsText, emails);

  /** @type {ImportProvisionAction} */
  let importAction = "normal";
  /** @type {PostExtractProvisionAction} */
  let postExtractAction = null;
  /** @type {string | null} */
  let message = null;

  if (cardRequiresRequest) {
    const msgParams = {
      method,
      email,
      inputsFolderWebViewLink: p.inputsFolderWebViewLink,
      provisionTermsText,
    };
    if (attachmentClass === "empty") {
      importAction = "block_analyze";
      postExtractAction = null;
      message = buildGateRequestMessage(msgParams);
    } else {
      importAction = "continue_analyze";
      if (attachmentClass === "sample_only") {
        postExtractAction = "show_request_and_wait";
        message = buildGateRequestMessage(msgParams);
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
      message: buildGateRequestMessage({
        method: gate.method,
        email: gate.email,
        inputsFolderWebViewLink: p.inputsFolderWebViewLink,
        provisionTermsText: gate.provisionTermsText,
      }),
    };
  }
  return { ...gate, postExtractAction: "normal", message: null };
}
