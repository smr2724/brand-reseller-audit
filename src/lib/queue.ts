// Shared priority-score helpers for the brand review queue.
// Spec:
//   (brand_score * 2)
//   + LEAST(est_monthly_revenue / 50000, 20)
//   + (manual_notes ? 5 : 0)
//   + (dominant_seller_sales_pct > 0.5 ? 10 : 0)
//   - LENGTH(disqualifier_tags) * 3
// Tie-break: brand_score DESC, est_monthly_revenue DESC, name ASC.

export interface QueueBrandLike {
  id: string;
  name: string;
  brand_score: number | null;
  est_monthly_revenue: number | null;
  manual_notes: string | null;
  dominant_seller_sales_pct: number | null;
  disqualifier_tags: string[] | null;
}

export function computePriorityScore(b: QueueBrandLike): number {
  const score = Number(b.brand_score ?? 0);
  const rev = Number(b.est_monthly_revenue ?? 0);
  const dom = Number(b.dominant_seller_sales_pct ?? 0);
  const tags = b.disqualifier_tags?.length ?? 0;

  return (
    score * 2 +
    Math.min(rev / 50000, 20) +
    (b.manual_notes ? 5 : 0) +
    (dom > 0.5 ? 10 : 0) -
    tags * 3
  );
}

export function sortQueue<T extends QueueBrandLike>(rows: T[]): (T & { priority_score: number })[] {
  return rows
    .map((b) => ({ ...b, priority_score: computePriorityScore(b) }))
    .sort((a, b) => {
      if (b.priority_score !== a.priority_score) return b.priority_score - a.priority_score;
      const ascA = Number(a.brand_score ?? 0);
      const ascB = Number(b.brand_score ?? 0);
      if (ascB !== ascA) return ascB - ascA;
      const revA = Number(a.est_monthly_revenue ?? 0);
      const revB = Number(b.est_monthly_revenue ?? 0);
      if (revB !== revA) return revB - revA;
      return (a.name ?? "").localeCompare(b.name ?? "");
    });
}
