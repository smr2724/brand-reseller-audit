"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Candidate {
  brand: string;
  asin_count: number;
  top_seller: string | null;
  est_monthly_revenue: number | null;
  confidence: number;
  example_asins: string[];
}

export default function AddBrandByName() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCandidates(null);
    setLoading(true);
    try {
      const res = await fetch("/api/brands/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "lookup failed");
      setCandidates(data.candidates ?? []);
      setFromCache(!!data.from_cache);
    } catch (err) {
      setError(err instanceof Error ? err.message : "lookup failed");
    } finally {
      setLoading(false);
    }
  }

  async function confirm(c: Candidate) {
    setError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/brands/create-from-lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand: c.brand }),
      });
      const data = await res.json();
      if (!res.ok || !data?.brand_id) {
        throw new Error(data?.error || "create failed");
      }
      router.push(`/app/brands/${data.brand_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
      setCreating(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={search} className="card p-4 flex gap-2">
        <input
          className="flex-1 px-3 py-2 rounded-md bg-[var(--bg-3)] border border-[var(--border)] text-sm"
          placeholder="e.g. World Amenities"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          required
          minLength={2}
          maxLength={200}
        />
        <button
          type="submit"
          className="btn btn-primary text-sm"
          disabled={loading || creating || query.trim().length < 2}
        >
          {loading ? "Searching…" : "Search Keepa"}
        </button>
      </form>

      {error && (
        <div className="card p-3 border border-red-700/50 bg-red-950/30 text-sm text-red-300">
          {error}
        </div>
      )}

      {candidates && candidates.length === 0 && !loading && (
        <div className="card p-4 text-sm">
          <div className="font-medium mb-1">Not found on Amazon US.</div>
          <div className="text-[var(--text-muted)]">
            Try a variant — e.g. drop &ldquo;Inc&rdquo;, add a space, or use
            the brand name as it appears on the storefront.
          </div>
        </div>
      )}

      {candidates && candidates.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-[var(--text-muted)]">
            {candidates.length} candidate{candidates.length === 1 ? "" : "s"} from Keepa{fromCache ? " (cached)" : ""}
          </div>
          {candidates.map((c, i) => (
            <div key={`${c.brand}-${i}`} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium">{c.brand}</div>
                  <div className="text-xs text-[var(--text-muted)] mt-1 space-x-3">
                    <span>{c.asin_count} ASIN{c.asin_count === 1 ? "" : "s"}</span>
                    {c.top_seller && <span>Top seller: {c.top_seller}</span>}
                    {c.est_monthly_revenue !== null && (
                      <span>~${c.est_monthly_revenue.toLocaleString()}/mo (preview)</span>
                    )}
                    <span>Confidence: {(c.confidence * 100).toFixed(0)}%</span>
                  </div>
                  {c.example_asins.length > 0 && (
                    <div className="mt-2 text-[11px] text-[var(--text-muted)] font-mono">
                      {c.example_asins.join(" · ")}
                    </div>
                  )}
                </div>
                <button
                  className="btn btn-primary text-xs whitespace-nowrap"
                  onClick={() => confirm(c)}
                  disabled={creating}
                >
                  {creating ? "Creating…" : "Confirm + Enrich"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <div className="card p-4 text-sm text-[var(--text-muted)]">
          Running Keepa + DataForSEO enrichment. This typically takes 30&ndash;60 seconds&hellip;
        </div>
      )}
    </div>
  );
}
