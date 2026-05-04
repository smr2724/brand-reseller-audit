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
}
