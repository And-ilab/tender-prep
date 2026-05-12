/**
 * @param {import('../model/types.js').TenderParseResult} result
 * @returns {import('../model/types.js').TenderSnapshot}
 */
export function toSnapshot(result) {
  const warnings = [...(result.meta?.warnings ?? [])];

  const reqSorted = [...result.requirements].sort((a, b) => a.id.localeCompare(b.id));
  const dedup = new Set();
  for (const r of reqSorted) {
    if (dedup.has(r.id)) {
      warnings.push(`Дублируется requirement id: ${r.id}`);
    }
    dedup.add(r.id);
  }

  for (const r of result.requirements) {
    if (r.needs_review === true) {
      warnings.push(`Требование ${r.id} помечено needs_review`);
    }
    if (typeof r.confidence === "number" && r.confidence < 0.5) {
      warnings.push(`Требование ${r.id}: низкая уверенность (${r.confidence})`);
    }
  }

  return {
    tender_id: result.tender_id,
    requirements: result.requirements,
    deadlines: result.deadlines,
    criteria: result.criteria ?? [],
    meta: {
      normalized_at: new Date().toISOString(),
      warnings,
    },
  };
}
