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
  low_confidence?: boolean;
  matched_variant?: string;
}

const SOURCE_BADGE_COPY: Record<FuzzyCandidate["source"], string> = {
  keepa: "Keepa",
  dataforseo: "Amazon search",
  both: "Keepa + Amazon",
  fallback: "Search Amazon",
};

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

  // Phase 28 — optional confirmed TTM revenue captured at picker time.
  // Persisted on the brand row on insert when a candidate is selected.
  const [showConfirmedTtm, setShowConfirmedTtm] = useState(false);
  const [confirmedTtmInput, setConfirmedTtmInput] = useState("");
  const [confirmedTtmSource, setConfirmedTtmSource] = useState("");

  // Phase 29 — H2O Therapy bug. When Confirm+Enrich fails (Vercel function
  // timeout, Keepa transient error, etc.) the user previously saw a
  // generic "Load failed" and could re-click the same candidate, queueing
  // up another enrichment run while the first was still being recovered
  // by the cron. Lock the picker after a failed attempt until the user
  // explicitly clicks "Try again" — at which point we reset and let them
  // choose again.
  const [createFailed, setCreateFailed] = useState(false);
  const [createFailedBrandId, setCreateFailedBrandId] = useState<string | null>(
    null,
  );

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
    // Phase 25.2: never auto-create a brand from the fallback row — its
    // name is the user's literal input, not a canonical Amazon brand. The
    // row exists only so the UI is never blank; the user is expected to
    // click through to Amazon and either come back with the canonical
    // name, or paste an ASIN into the resolver below.
    if (c.source === "fallback") return;
    await createBrand(c.name);
  }

  async function createBrand(brand: string) {
    setError(null);
    setCreating(true);
    setCreateFailed(false);
    try {
      const body: Record<string, unknown> = { brand };
      // Phase 28 — only attach the confirmed TTM payload if the user
      // actually expanded the form and entered a positive number.
      const confirmedNum = Number(confirmedTtmInput.replace(/[$,\s]/g, ""));
      if (
        showConfirmedTtm &&
        Number.isFinite(confirmedNum) &&
        confirmedNum > 0
      ) {
        body.confirmed_ttm_revenue_dollars = confirmedNum;
        if (confirmedTtmSource.trim().length > 0) {
          body.confirmed_ttm_source = confirmedTtmSource.trim();
        }
      }
      const res = await fetch("/api/brands/create-from-lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res
        .json()
        .catch(() => ({}) as Record<string, unknown>);
      if (!res.ok) {
        // Phase 29 — surface the structured error from the route. Even
        // on 502 the brand row was inserted, so capture the brand_id so
        // the user has a way to reach the detail page if they want.
        const brandId =
          typeof data?.brand_id === "string" ? data.brand_id : null;
        if (brandId) setCreateFailedBrandId(brandId);
        const msg =
          (typeof data?.error === "string" && data.error) ||
          (typeof data?.keepa_error === "string" && data.keepa_error) ||
          "create failed";
        throw new Error(msg);
      }
      if (!data?.brand_id) {
        throw new Error((data?.error as string) || "create failed");
      }
      router.push(`/app/brands/${data.brand_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
      setCreating(false);
      setCreateFailed(true);
    }
  }

  // Phase 29 — explicit user-driven reset after a failed create. Clears
  // the lock and any stale failure state so the user can try a different
  // candidate (or the same candidate after the cron has had a chance to
  // recover the brand).
  function resetAfterFailure() {
    setCreateFailed(false);
    setCreateFailedBrandId(null);
    setError(null);
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
      <form onSubmit={search} className="card p-4 space-y-3">
        <div className="flex gap-2">
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
        </div>
        <div>
          <button
            type="button"
            className="text-xs text-[var(--accent)] underline"
            onClick={() => setShowConfirmedTtm((v) => !v)}
          >
            {showConfirmedTtm
              ? "Hide confirmed TTM revenue"
              : "Have confirmed TTM revenue? (optional)"}
          </button>
          {showConfirmedTtm && (
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                className="px-3 py-2 rounded-md bg-[var(--bg-3)] border border-[var(--border)] text-sm"
                placeholder="$ TTM revenue (e.g. 1500000)"
                value={confirmedTtmInput}
                onChange={(e) => setConfirmedTtmInput(e.target.value)}
                inputMode="decimal"
                maxLength={20}
              />
              <input
                className="px-3 py-2 rounded-md bg-[var(--bg-3)] border border-[var(--border)] text-sm"
                placeholder="Source (e.g. Orion data, seller call)"
                value={confirmedTtmSource}
                onChange={(e) => setConfirmedTtmSource(e.target.value)}
                maxLength={200}
              />
              <div className="text-[11px] text-[var(--text-muted)] sm:col-span-2">
                Bypasses the Keepa/price estimator. Used as the revenue
                base for all downstream math when set. Internal-only.
              </div>
            </div>
          )}
        </div>
      </form>

      {error && (
        <div className="card p-3 border border-red-700/50 bg-red-950/30 text-sm text-red-300 space-y-2">
          <div>{error}</div>
          {createFailed && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button
                type="button"
                className="btn btn-ghost text-xs"
                onClick={resetAfterFailure}
              >
                Try again
              </button>
              {createFailedBrandId && (
                <a
                  href={`/app/brands/${createFailedBrandId}`}
                  className="underline text-[var(--accent)]"
                >
                  Open brand anyway →
                </a>
              )}
              <span className="text-[var(--text-muted)]">
                The recovery sweep retries stuck brands every 5 minutes.
              </span>
            </div>
          )}
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
                  disabled={creating || createFailed}
                >
                  {creating
                    ? "Creating…"
                    : createFailed
                      ? "Click Try again first"
                      : "Confirm + Enrich"}
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
          createFailed={createFailed}
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
  createFailed: boolean;
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
    createFailed,
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
          {list.map((c, i) => {
            const isFallback = c.source === "fallback";
            return (
              <button
                key={`${c.name}-${i}`}
                type="button"
                onClick={() => onSelect(c)}
                disabled={creating || createFailed || isFallback}
                className={`card p-4 w-full text-left transition-colors ${
                  isFallback
                    ? "opacity-70 cursor-default"
                    : "hover:border-[var(--accent)] disabled:opacity-50"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">
                        {isFallback ? `No canonical match — search Amazon for “${c.name}”` : c.name}
                      </span>
                      <span
                        className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                          isFallback
                            ? "bg-yellow-900/40 text-yellow-300 border border-yellow-700/50"
                            : "bg-[var(--bg-3)] text-[var(--text-muted)] border border-[var(--border)]"
                        }`}
                      >
                        {SOURCE_BADGE_COPY[c.source]}
                      </span>
                      {c.low_confidence && !isFallback && (
                        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-[var(--bg-3)] text-[var(--text-muted)] border border-[var(--border)]">
                          low confidence
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-[var(--text-muted)] mt-1 space-x-3">
                      {c.asin_count !== null && (
                        <span>{c.asin_count} ASIN{c.asin_count === 1 ? "" : "s"}</span>
                      )}
                      {!isFallback && (
                        <span>Match: {(c.similarity * 100).toFixed(0)}%</span>
                      )}
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
            );
          })}
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
