/**
 * Phase 61 — Per-discovery-run audit-trail events.
 *
 * `brand_contact_discovery_events` is parallel to `api_logs`. Where
 * `api_logs` is the billing/aggregate cost stream, this table is the
 * per-brand, per-run, per-contact transparency view the UI reads to
 * render the expandable provider-chain panel under each contact row.
 *
 * One `run_id` is generated at the start of `runContactDiscovery` and
 * threaded into every helper that emits events; events tied to a
 * specific candidate carry `contact_id` once that row exists in
 * `brand_contacts` (domain-level events like Hunter domain-search have
 * a null `contact_id`).
 */
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type DiscoveryEventProvider =
  | "apollo_search"
  | "apollo_match"
  | "hunter_domain"
  | "hunter_finder"
  | "millionverifier"
  | "zerobounce"
  | "pattern_guess"
  | "orchestrator"
  | "enrichment_deferred"
  | "linkedin_verify"
  | "hunter_pattern"
  | "llm_websearch"
  | "manual";

export type DiscoveryEventOutcome =
  | "found"
  | "not_found"
  | "skipped"
  | "error"
  | "retry_exhausted";

const RAW_PAYLOAD_MAX_BYTES = 64 * 1024;

export interface DiscoveryEventInput {
  brand_id: string;
  run_id: string;
  contact_id?: string | null;
  provider: DiscoveryEventProvider;
  outcome: DiscoveryEventOutcome;
  reason?: string | null;
  email_returned?: string | null;
  status_returned?: string | null;
  score_returned?: number | null;
  http_status?: number | null;
  raw_payload?: unknown;
}

function truncatePayload(raw: unknown): unknown {
  if (raw == null) return null;
  try {
    const json = JSON.stringify(raw);
    if (json.length <= RAW_PAYLOAD_MAX_BYTES) return raw;
    return {
      _truncated: true,
      _original_bytes: json.length,
      preview: json.slice(0, RAW_PAYLOAD_MAX_BYTES),
    };
  } catch {
    return { _serialize_error: true };
  }
}

export async function recordDiscoveryEvent(
  ev: DiscoveryEventInput,
): Promise<void> {
  try {
    const admin = createSupabaseAdminClient();
    if (!admin) return;
    await admin.from("brand_contact_discovery_events").insert({
      brand_id: ev.brand_id,
      run_id: ev.run_id,
      contact_id: ev.contact_id ?? null,
      provider: ev.provider,
      outcome: ev.outcome,
      reason: ev.reason ?? null,
      email_returned: ev.email_returned ?? null,
      status_returned: ev.status_returned ?? null,
      score_returned:
        typeof ev.score_returned === "number" && Number.isFinite(ev.score_returned)
          ? ev.score_returned
          : null,
      http_status:
        typeof ev.http_status === "number" && Number.isFinite(ev.http_status)
          ? ev.http_status
          : null,
      raw_payload: truncatePayload(ev.raw_payload),
    });
  } catch {
    /* never block discovery on event-log failures */
  }
}
