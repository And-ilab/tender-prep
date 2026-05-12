const defaultEvidence = "—";

/**
 * @param {import('../model/types.js').TenderSnapshot} snapshot
 * @returns {import('../model/types.js').ComplianceMatrix}
 */
export function buildComplianceMatrix(snapshot) {
  const rows = snapshot.requirements.map((r) => ({
    requirement_id: r.id,
    requirement_text: r.text,
    status: "open",
    evidence_ref: defaultEvidence,
    notes:
      r.needs_review === true
        ? "needs_review: проверить вручную"
        : typeof r.confidence === "number" && r.confidence < 0.8
          ? `confidence=${r.confidence}`
          : undefined,
  }));

  return {
    tender_id: snapshot.tender_id,
    rows,
    generated_at: new Date().toISOString(),
  };
}
