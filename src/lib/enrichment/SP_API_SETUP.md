# SP-API Override Setup

The v2 audit pipeline supports replacing the Keepa BSR-derived revenue
**estimate** with the seller's **actual** trailing-12mo Amazon sales,
pulled via the Pipedream-hosted `amazon_selling_partner__pipedream`
connector.

This file documents how to wire up the override for a brand and
configure the runtime.

## When the override fires

`pullTrailing12FromSpApi()` runs once at the top of `runV2Enrichment`,
**before** the Keepa pass. Decision tree:

1. Brand has no row in `brand_sp_api_links` → `no_link` →
   pipeline runs the Keepa estimator. (Cold-prospect path.)
2. Brand has a row, but `SP_API_CONNECTOR_TOOL` env is unset →
   `connector_unavailable` → pipeline falls back to Keepa.
3. Brand has a row, env is set, connector returns data →
   `trailing_12mo_revenue` flows into the math section, the revenue row
   shows a green "Actual" badge, and the estimator footnote is dropped.
4. Connector returns an error or no ASIN-level rows →
   `connector_no_access` / `connector_error` → fallback to Keepa.

## Adding an override for a brand

1. Run migration `0022_brand_sp_api_links.sql` once per environment.
2. Confirm the connector account in `amazon_selling_partner__pipedream`
   has Seller Central read access to the brand. If not, **stop here** —
   the override will fall back gracefully but won't produce real data.
3. Insert a row:

   ```sql
   insert into brand_sp_api_links (brand_id, marketplace_id, connector_account, notes)
   values (
     '<brand-uuid>',
     'ATVPDKIKX0DER',          -- Amazon US
     'steve@diversifiedhospitality.com',
     'Owner: Acme Brands LLC; scope: full read'
   );
   ```

## Wiring the connector at runtime

The dispatch stub `callConnector()` in `sp-api-override.ts` is
currently a placeholder. To enable production calls:

1. Set `SP_API_CONNECTOR_TOOL` on Vercel/local to the tool name your
   runtime exposes (e.g.
   `amazon_selling_partner__pipedream/getSalesAndTrafficReport`).
2. Replace the body of `callConnector()` to dispatch HTTP through your
   tool runtime (claude.ai MCP-proxy, Pipedream HTTP, etc.).
3. The expected response shape is documented on
   `parseTrailing12FromConnectorResponse()`. Pre-aggregate from
   `getOrders` if the chosen endpoint doesn't natively return
   per-ASIN trailing-period sales.

Until step (2) lands, production runs return `connector_unavailable`
and silently use the Keepa estimator. This is by design — the override
is opt-in and never blocks the cold-prospect flow.

## Testing without a real seller account

`scripts/test-sp-api-override.ts` exercises the full flow with an
in-memory Supabase stub and `setMockSpApiResponse()`. Run:

```sh
npx tsx scripts/test-sp-api-override.ts
```

The mock path covers:
* parser correctness for `getSalesAndTrafficReport` payloads
* `no_link` cold-prospect short-circuit
* `connector_unavailable` graceful fallback
* mock-injected real-data path, end-to-end
