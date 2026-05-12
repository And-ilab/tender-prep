/**
 * @typedef {{ path: string, message: string }} ValidationIssue
 */

/**
 * @param {unknown} v
 * @returns {v is string}
 */
function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isSourceRef(v) {
  if (v === null || typeof v !== "object") return false;
  const s = /** @type {Record<string, unknown>} */ (v);
  return (
    (s.file !== undefined && typeof s.file === "string") ||
    (s.fragment !== undefined && typeof s.fragment === "string") ||
    (s.page !== undefined && typeof s.page === "number")
  );
}

/**
 * @param {unknown} raw
 * @param {number} index
 * @returns {import('../model/types.js').Requirement | ValidationIssue[]}
 */
function readRequirement(raw, index) {
  if (raw === null || typeof raw !== "object") {
    return [{ path: `requirements[${index}]`, message: "Ожидался объект" }];
  }
  const r = /** @type {Record<string, unknown>} */ (raw);
  /** @type {ValidationIssue[]} */
  const issues = [];
  if (!isNonEmptyString(r.id)) issues.push({ path: `requirements[${index}].id`, message: "Нужна непустая строка" });
  if (!isNonEmptyString(r.text)) issues.push({ path: `requirements[${index}].text`, message: "Нужна непустая строка" });
  if (!isSourceRef(r.source)) {
    issues.push({
      path: `requirements[${index}].source`,
      message: "Нужен объект source с file, fragment и/или page",
    });
  }
  if (issues.length) return issues;

  const source = /** @type {Record<string, unknown>} */ (r.source);
  /** @type {import('../model/types.js').Requirement} */
  const req = {
    id: /** @type {string} */ (r.id).trim(),
    text: /** @type {string} */ (r.text).trim(),
    source: {
      file: source.file !== undefined ? String(source.file) : undefined,
      fragment: source.fragment !== undefined ? String(source.fragment) : undefined,
      page: typeof source.page === "number" ? source.page : undefined,
    },
  };
  if (typeof r.confidence === "number") req.confidence = r.confidence;
  if (typeof r.needs_review === "boolean") req.needs_review = r.needs_review;
  return req;
}

/**
 * @param {unknown} raw
 * @param {number} index
 * @returns {import('../model/types.js').DeadlineEntry | ValidationIssue[]}
 */
function readDeadline(raw, index) {
  if (raw === null || typeof raw !== "object") {
    return [{ path: `deadlines[${index}]`, message: "Ожидался объект" }];
  }
  const r = /** @type {Record<string, unknown>} */ (raw);
  /** @type {ValidationIssue[]} */
  const issues = [];
  if (!isNonEmptyString(r.id)) issues.push({ path: `deadlines[${index}].id`, message: "Нужна непустая строка" });
  if (!isNonEmptyString(r.label)) issues.push({ path: `deadlines[${index}].label`, message: "Нужна непустая строка" });
  if (!isSourceRef(r.source)) {
    issues.push({
      path: `deadlines[${index}].source`,
      message: "Нужен объект source с file, fragment и/или page",
    });
  }
  if (issues.length) return issues;

  const source = /** @type {Record<string, unknown>} */ (r.source);
  /** @type {import('../model/types.js').DeadlineEntry} */
  const d = {
    id: /** @type {string} */ (r.id).trim(),
    label: /** @type {string} */ (r.label).trim(),
    source: {
      file: source.file !== undefined ? String(source.file) : undefined,
      fragment: source.fragment !== undefined ? String(source.fragment) : undefined,
      page: typeof source.page === "number" ? source.page : undefined,
    },
  };
  if (typeof r.datetime === "string" && r.datetime.trim()) d.datetime = r.datetime.trim();
  if (typeof r.needs_review === "boolean") d.needs_review = r.needs_review;
  return d;
}

/**
 * @param {unknown} raw
 * @param {number} index
 * @returns {import('../model/types.js').EvaluationCriterion | ValidationIssue[]}
 */
function readCriterion(raw, index) {
  if (raw === null || typeof raw !== "object") {
    return [{ path: `criteria[${index}]`, message: "Ожидался объект" }];
  }
  const r = /** @type {Record<string, unknown>} */ (raw);
  if (!isNonEmptyString(r.raw)) {
    return [{ path: `criteria[${index}].raw`, message: "Нужна непустая строка" }];
  }
  /** @type {import('../model/types.js').EvaluationCriterion} */
  const c = { raw: /** @type {string} */ (r.raw).trim() };
  if (r.source !== undefined) {
    if (!isSourceRef(r.source)) {
      return [{ path: `criteria[${index}].source`, message: "Некорректный source" }];
    }
    const source = /** @type {Record<string, unknown>} */ (r.source);
    c.source = {
      file: source.file !== undefined ? String(source.file) : undefined,
      fragment: source.fragment !== undefined ? String(source.fragment) : undefined,
      page: typeof source.page === "number" ? source.page : undefined,
    };
  }
  if (typeof r.needs_review === "boolean") c.needs_review = r.needs_review;
  return c;
}

/**
 * @param {unknown} data
 * @returns {{ ok: true, value: import('../model/types.js').TenderParseResult } | { ok: false, issues: ValidationIssue[] }}
 */
export function validateTenderParseResult(data) {
  /** @type {ValidationIssue[]} */
  const issues = [];
  if (data === null || typeof data !== "object") {
    return { ok: false, issues: [{ path: "", message: "Ожидался объект JSON" }] };
  }
  const o = /** @type {Record<string, unknown>} */ (data);

  if (!isNonEmptyString(o.tender_id)) {
    issues.push({ path: "tender_id", message: "Нужна непустая строка" });
  }

  /** @type {import('../model/types.js').Requirement[]} */
  const requirements = [];
  if (!Array.isArray(o.requirements)) {
    issues.push({ path: "requirements", message: "Ожидался массив" });
  } else {
    for (let i = 0; i < o.requirements.length; i++) {
      const p = readRequirement(o.requirements[i], i);
      if (Array.isArray(p)) issues.push(...p);
      else requirements.push(p);
    }
  }

  /** @type {import('../model/types.js').DeadlineEntry[]} */
  const deadlines = [];
  if (!Array.isArray(o.deadlines)) {
    issues.push({ path: "deadlines", message: "Ожидался массив" });
  } else {
    for (let i = 0; i < o.deadlines.length; i++) {
      const p = readDeadline(o.deadlines[i], i);
      if (Array.isArray(p)) issues.push(...p);
      else deadlines.push(p);
    }
  }

  /** @type {import('../model/types.js').EvaluationCriterion[] | undefined} */
  let criteria;
  if (o.criteria !== undefined) {
    if (!Array.isArray(o.criteria)) {
      issues.push({ path: "criteria", message: "Если есть, criteria должен быть массивом" });
    } else {
      criteria = [];
      for (let i = 0; i < o.criteria.length; i++) {
        const p = readCriterion(o.criteria[i], i);
        if (Array.isArray(p)) issues.push(...p);
        else criteria.push(p);
      }
    }
  }

  if (o.meta !== undefined) {
    if (o.meta === null || typeof o.meta !== "object") {
      issues.push({ path: "meta", message: "Если есть, meta должен быть объектом" });
    } else {
      const m = /** @type {Record<string, unknown>} */ (o.meta);
      if (m.parser_version !== undefined && typeof m.parser_version !== "string") {
        issues.push({ path: "meta.parser_version", message: "Ожидалась строка" });
      }
      if (m.warnings !== undefined) {
        if (!Array.isArray(m.warnings) || !m.warnings.every((w) => typeof w === "string")) {
          issues.push({ path: "meta.warnings", message: "Ожидался массив строк" });
        }
      }
    }
  }

  if (issues.length) {
    return { ok: false, issues };
  }

  const metaIn =
    o.meta && typeof o.meta === "object" ? /** @type {Record<string, unknown>} */ (o.meta) : undefined;

  /** @type {import('../model/types.js').TenderParseResult} */
  const value = {
    tender_id: /** @type {string} */ (o.tender_id).trim(),
    requirements,
    deadlines,
    criteria,
    meta: metaIn
      ? {
          parser_version:
            typeof metaIn.parser_version === "string" ? metaIn.parser_version : undefined,
          warnings: Array.isArray(metaIn.warnings) ? /** @type {string[]} */ (metaIn.warnings).slice() : undefined,
        }
      : undefined,
  };

  return { ok: true, value };
}

export {};
