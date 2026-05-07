/**
 * Phase 47 — Apollo form-body encoder, hoisted out of
 * `src/lib/owner-resolver/apollo-client.ts` so the new contact-discovery
 * + qualification surfaces can share it. The original location keeps a
 * back-compat re-export.
 *
 * Apollo expects array params as repeated `key[]=value` (PHP-style),
 * NOT JSON. Sending JSON to e.g. `mixed_companies/search` returns a
 * generic empty result instead of the matching organizations.
 */
export function encodeApolloFormBody(body: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v === null || v === undefined) continue;
        parts.push(
          `${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(v))}`,
        );
      }
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}
