/**
 * Shared types for web-search provider adapters (Perplexity, Brave,
 * OpenAI). All adapters normalize their raw responses into `ProviderResult`
 * so the orchestrator can treat them interchangeably.
 */
export interface WebSearchResultItem {
  title: string | null;
  url: string;
  snippet: string | null;
  query: string;
}

export interface ProviderResult {
  items: WebSearchResultItem[];
  raw: unknown;
  error: string | null;
  /**
   * Phase 34.1 — Full assistant message text for the query, concatenated
   * across all `output_text` blocks. Captures sentences like
   * "produced by Diversified Hospitality Solutions, based in San Diego"
   * that the snippet field truncates. Null when the provider doesn't expose
   * a freeform answer (e.g. raw web index APIs).
   */
  full_text?: string | null;
}

/**
 * Phase 34.1 — Per-query block fed to the extractor: the full multi-paragraph
 * answer text plus the citation URLs the model attached. Lets the extractor
 * read the actual evidence sentence ("produced by …") rather than guessing
 * from titles + truncated snippets.
 */
export interface PerQueryAnswer {
  query: string;
  full_text: string | null;
  citation_urls: Array<{ url: string; title: string | null }>;
}
