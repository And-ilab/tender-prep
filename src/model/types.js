/**
 * @typedef {Object} TenderParseOptions
 * @property {boolean} [extract_requirements]
 * @property {boolean} [extract_deadlines]
 */

/**
 * @typedef {Object} TenderParseRequest
 * @property {string} tender_id
 * @property {string[]} document_urls
 * @property {string} locale
 * @property {TenderParseOptions} [options]
 */

/**
 * @typedef {Object} SourceRef
 * @property {string} [file]
 * @property {string} [fragment]
 * @property {number} [page]
 */

/**
 * @typedef {Object} Requirement
 * @property {string} id
 * @property {string} text
 * @property {SourceRef} source
 * @property {number} [confidence]
 * @property {boolean} [needs_review]
 */

/**
 * @typedef {Object} DeadlineEntry
 * @property {string} id
 * @property {string} label
 * @property {string} [datetime]
 * @property {SourceRef} source
 * @property {boolean} [needs_review]
 */

/**
 * @typedef {Object} EvaluationCriterion
 * @property {string} raw
 * @property {SourceRef} [source]
 * @property {boolean} [needs_review]
 */

/**
 * @typedef {Object} TenderParseResult
 * @property {string} tender_id
 * @property {Requirement[]} requirements
 * @property {DeadlineEntry[]} deadlines
 * @property {EvaluationCriterion[]} [criteria]
 * @property {{ parser_version?: string, warnings?: string[] }} [meta]
 */

/**
 * @typedef {Object} TenderSnapshot
 * @property {string} tender_id
 * @property {Requirement[]} requirements
 * @property {DeadlineEntry[]} deadlines
 * @property {EvaluationCriterion[]} criteria
 * @property {{ normalized_at: string, warnings: string[] }} meta
 */

/**
 * @typedef {'open'|'partial'|'done'|'na'} MatrixStatus
 */

/**
 * @typedef {Object} MatrixRow
 * @property {string} requirement_id
 * @property {string} requirement_text
 * @property {MatrixStatus} status
 * @property {string} evidence_ref
 * @property {string} [notes]
 */

/**
 * @typedef {Object} ComplianceMatrix
 * @property {string} tender_id
 * @property {MatrixRow[]} rows
 * @property {string} generated_at
 */

export {};
