"use client";

/**
 * Phase 25 — Fuzzy brand picker.
 *
 * Going-forward principle: search inputs to brand discovery should never
 * return zero results unless we've tried at least (1) exact, (2) deterministic
 * variants, (3) external Amazon search. Always show the user something
 * selectable, even if low confidence — humans pick the right brand from a
 * small list better than fuzzy matchers do.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

interface KeepaCandidate {
  brand: string;
  asin_count: number;
  top_seller: string | null;
  est_monthly_revenue: number | null;
  confidence: number;
  example_asins: string[];
}

interface FuzzyCandidate {
  name: string;
  source: "keepa" | "dataforseo" | "both" | "fallback";
  asin_count: number | null;
  storefront_url: string | null;
  similarity: number;
  matched_variant?: string;
}

export default function AddBrandByName() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [keepaCandidates, setKeepaCandidates] = useState<KeepaCandidate[] | null>(null);
  const [fuzzyCandidates, setFuzzyCandidates] = useState<FuzzyCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [searchingMore, setSearchingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  const [showAsin, setShowAsin] = useState(false);
  const [asinInput, setAsinInput] = useState("");
  const [resolving, setResolving] = useState(false);

  function resetResults() {
    setKeepaCandidates(null);
    setFuzzyCandidates(null);
    setExhausted(false);
    setSearchingMore(false);
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    resetResults();
    setLoading(true);
    try {
      const res = await fetch("/api/brands/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "lookup failed");
      const cands: KeepaCandidate[] = data.candidates ?? [];
      setKeepaCandidates(cands);
      setFromCache(!!data.from_cache);

      // Phase 25: when the exact-match Keepa lookup returns zero results,
      // fall through to the fuzzy picker (variant fan-out + DFS Amazon SERP).
      if (cands.length === 0) {
        await runFuzzy(query, "tight");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "lookup failed");
    } finally {
      setLoading(false);
    }
  }

  async function runFuzzy(q: string, mode: "tight" | "loose") {
    setSearchingMore(mode === "loose");
    try {
      const res = await fetch("/api/brands/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, mode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "search failed");
      setFuzzyCandidates(data.candidates ?? []);
      setExhausted(!!data.exhausted);
    } catch (err) {
      setError(err instanceof Error ? err.message : "search failed");
    } finally {
      setSearchingMore(false);
    }
  }

  async function confirmKeepa(c: KeepaCandidate) {
    await createBrand(c.brand);
  }

  async function confirmFuzzy(c: FuzzyCandidate) {
    await createBrand(c.name);
  }

  async function createBrand(brand: string) {
    setError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/brands/create-from-lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand }),
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

  async function resolveAsin() {
    setError(null);
    setResolving(true);
    try {
      const res = await fetch("/api/brands/resolve-asin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asin_or_url: asinInput }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "resolve failed");
      if (!data.brand) {
        throw new Error("Could not resolve a brand from that ASIN/URL.");
      }
      await createBrand(data.brand);
    } catch (err) {
      setError(err instanceof Error ? err.message : "resolve failed");
      setResolving(false);
    }
  }

  const showFuzzyPicker =
    keepaCandidates !== null && keepaCandidates.length === 0 && !loading;

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

      {keepaCandidates && keepaCandidates.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-[var(--text-muted)]">
            {keepaCandidates.length} candidate{keepaCandidates.length === 1 ? "" : "s"} from Keepa{fromCache ? " (cached)" : ""}
          </div>
          {keepaCandidates.map((c, i) => (
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
                  onClick={() => confirmKeepa(c)}
                  disabled={creating}
                >
                  {creating ? "Creating…" : "Confirm + Enrich"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showFuzzyPicker && (
        <FuzzyPicker
          query={query}
          candidates={fuzzyCandidates}
          searchingMore={searchingMore}
          exhausted={exhausted}
          creating={creating}
          onSelect={confirmFuzzy}
          onSearchMore={() => runFuzzy(query, "loose")}
          showAsin={showAsin}
          setShowAsin={setShowAsin}
          asinInput={asinInput}
          setAsinInput={setAsinInput}
          resolving={resolving}
          onResolveAsin={resolveAsin}
        />
      )}

      {creating && (
        <div className="card p-4 text-sm text-[var(--text-muted)]">
          Running Keepa + DataForSEO enrichment. This typically takes 30&ndash;60 seconds&hellip;
        </div>
      )}
    </div>
  );
}

interface FuzzyPickerProps {
  query: string;
  candidates: FuzzyCandidate[] | null;
  searchingMore: boolean;
  exhausted: boolean;
  creating: boolean;
  onSelect: (c: FuzzyCandidate) => void;
  onSearchMore: () => void;
  showAsin: boolean;
  setShowAsin: (v: boolean) => void;
  asinInput: string;
  setAsinInput: (v: string) => void;
  resolving: boolean;
  onResolveAsin: () => void;
}

function FuzzyPicker(props: FuzzyPickerProps) {
  const {
    query,
    candidates,
    searchingMore,
    exhausted,
    creating,
    onSelect,
    onSearchMore,
    showAsin,
    setShowAsin,
    asinInput,
    setAsinInput,
    resolving,
    onResolveAsin,
  } = props;

  const list = candidates ?? [];

  return (
    <div className="space-y-3">
      <div className="card p-4">
        <div className="font-medium mb-1 text-sm">
          No exact match for &ldquo;{query}&rdquo; on Amazon US.
        </div>
        <div className="text-xs text-[var(--text-muted)]">
          Here&rsquo;s what we found by trying common variants and an Amazon
          search. Pick the one that matches the brand you&rsquo;re after.
        </div>
      </div>

      {searchingMore && list.length === 0 && (
        <div className="card p-4 text-sm text-[var(--text-muted)]">
          Searching variants and Amazon&hellip;
        </div>
      )}

      {list.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-[var(--text-muted)]">
            {list.length} candidate{list.length === 1 ? "" : "s"} (ranked by similarity)
          </div>
          {list.map((c, i) => (
            <button
              key={`${c.name}-${i}`}
              type="button"
              onClick={() => onSelect(c)}
              disabled={creating}
              className="card p-4 w-full text-left hover:border-[var(--accent)] disabled:opacity-50 transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-[var(--text-muted)] mt-1 space-x-3">
                    {c.asin_count !== null && (
                      <span>{c.asin_count} ASIN{c.asin_count === 1 ? "" : "s"}</span>
                    )}
                    <span>Match: {(c.similarity * 100).toFixed(0)}%</span>
                    <span>Source: {c.source}</span>
                  </div>
                </div>
                {c.storefront_url && (
                  <a
                    href={c.storefront_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs underline text-[var(--accent)] whitespace-nowrap"
                    onClick={(e) => e.stopPropagation()}
                  >
                    View on Amazon →
                  </a>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {!exhausted && (
        <button
          type="button"
          onClick={onSearchMore}
          disabled={searchingMore || creating}
          className="btn btn-ghost text-xs"
        >
          {searchingMore ? "Searching more options…" : "Search more options"}
        </button>
      )}

      <div className="card p-4 space-y-2">
        <button
          type="button"
          onClick={() => setShowAsin(!showAsin)}
          className="text-xs text-[var(--accent)] underline"
        >
          {showAsin ? "Hide" : "I have an ASIN or storefront URL"}
        </button>
        {showAsin && (
          <div className="flex gap-2">
            <input
              className="flex-1 px-3 py-2 rounded-md bg-[var(--bg-3)] border border-[var(--border)] text-sm font-mono"
              placeholder="B07XKZTC4M or amazon.com/dp/…"
              value={asinInput}
              onChange={(e) => setAsinInput(e.target.value)}
              maxLength={500}
            />
            <button
              type="button"
              onClick={onResolveAsin}
              disabled={resolving || creating || asinInput.trim().length < 3}
              className="btn btn-primary text-xs whitespace-nowrap"
            >
              {resolving ? "Resolving…" : "Resolve brand"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
