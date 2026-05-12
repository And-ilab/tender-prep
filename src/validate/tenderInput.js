/**
 * @param {unknown} v
 * @returns {v is string}
 */
function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * @param {unknown} v
 * @returns {v is string[]}
 */
function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * @param {unknown} data
 * @returns {{ ok: true, value: import('../model/types.js').TenderParseRequest } | { ok: false, issues: import('./parserResult.js').ValidationIssue[] }}
 */
export function validateTenderParseRequest(data) {
  /** @type {import('./parserResult.js').ValidationIssue[]} */
  const issues = [];

  if (data === null || typeof data !== "object") {
    return { ok: false, issues: [{ path: "", message: "Ожидался объект JSON" }] };
  }

  const o = /** @type {Record<string, unknown>} */ (data);

  if (!isNonEmptyString(o.tender_id)) {
    issues.push({ path: "tender_id", message: "Нужна непустая строка" });
  }

  if (!isStringArray(o.document_urls) || o.document_urls.length === 0) {
    issues.push({
      path: "document_urls",
      message: "Нужен непустой массив строк (URL или идентификаторы документов)",
    });
  } else {
    o.document_urls.forEach((u, i) => {
      if (!u.trim()) {
        issues.push({ path: `document_urls[${i}]`, message: "Пустая строка недопустима" });
      }
    });
  }

  if (!isNonEmptyString(o.locale)) {
    issues.push({ path: "locale", message: "Нужна непустая строка (например ru)" });
  }

  if (o.options !== undefined) {
    if (o.options === null || typeof o.options !== "object") {
      issues.push({ path: "options", message: "Если есть, options должен быть объектом" });
    } else {
      const opt = /** @type {Record<string, unknown>} */ (o.options);
      for (const k of Object.keys(opt)) {
        if (k !== "extract_requirements" && k !== "extract_deadlines") {
          issues.push({ path: `options.${k}`, message: "Неизвестное поле" });
        }
      }
      if (
        opt.extract_requirements !== undefined &&
        typeof opt.extract_requirements !== "boolean"
      ) {
        issues.push({ path: "options.extract_requirements", message: "Ожидался boolean" });
      }
      if (opt.extract_deadlines !== undefined && typeof opt.extract_deadlines !== "boolean") {
        issues.push({ path: "options.extract_deadlines", message: "Ожидался boolean" });
      }
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  /** @type {import('../model/types.js').TenderParseRequest} */
  const value = {
    tender_id: /** @type {string} */ (o.tender_id).trim(),
    document_urls: /** @type {string[]} */ (o.document_urls).map((s) => s.trim()),
    locale: /** @type {string} */ (o.locale).trim(),
    options:
      o.options && typeof o.options === "object"
        ? {
            extract_requirements: /** @type {boolean|undefined} */ (
              /** @type {Record<string, unknown>} */ (o.options).extract_requirements
            ),
            extract_deadlines: /** @type {boolean|undefined} */ (
              /** @type {Record<string, unknown>} */ (o.options).extract_deadlines
            ),
          }
        : undefined,
  };

  return { ok: true, value };
}
