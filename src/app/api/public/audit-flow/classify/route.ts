/**
 * Phase 43 — Public client-facing audit flow, Step 2 submit:
 * persist seller classifications captured by the wizard.
 *
 * Mirrors the admin
 * `/api/brands/[id]/sellers/classifications` endpoint, but is
 * authenticated via the lead's flow_token instead of an authed user
 * session, and stamps `classified_by_audit_request_id = lead.id` so the
 * admin app can tell public-flow classifications apart from
 * admin-classified ones.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { sha256Hex } from "@/lib/audit-request/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID = new Set(["brand_owned", "authorized", "amazon", "reseller"]);

const Body = z.object({
  lead_id: z.string().uuid(),
  lead_token: z.string().min(1),
  classifications: z
    .array(
      z.object({
        seller_id: z.string().nullable().optional(),
        seller_name: z.string().nullable().optional(),
        classification: z.string(),
      }),
    )
    .min(1),
});

export async function POST(req: Request) {
  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(bodyJson);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const data = parsed.data;

  for (const c of data.classifications) {
    if (!VALID.has(c.classification)) {
      return NextResponse.json(
        {
          error: `invalid classification "${c.classification}" — must be one of brand_owned/authorized/amazon/reseller`,
        },
        { status: 400 },
      );
    }
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  }

  const tokenHash = sha256Hex(data.lead_token);
  const { data: lead } = await admin
    .from("leads")
    .select("id, brand_id, flow_token_hash, email_verify_token_hash")
    .eq("id", data.lead_id)
    .maybeSingle();
  if (!lead) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const ok =
    lead.flow_token_hash === tokenHash ||
    lead.email_verify_token_hash === tokenHash;
  if (!ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!lead.brand_id) {
    return NextResponse.json({ error: "brand not resolved yet" }, { status: 409 });
  }

  const nowIso = new Date().toISOString();
  let updated = 0;
  for (const c of data.classifications) {
    const update: Record<string, unknown> = {
      classification: c.classification,
      classified_at: nowIso,
      classified_by_audit_request_id: data.lead_id,
      is_brand_controlled:
        c.classification === "brand_owned" || c.classification === "authorized",
    };

    let q = admin.from("brand_sellers").update(update).eq("brand_id", lead.brand_id);
    if (c.seller_id) {
      q = q.eq("seller_id", c.seller_id);
    } else if (c.seller_name) {
      q = q.eq("seller_name", c.seller_name);
    } else {
      continue;
    }
    let result = await q.select("id");
    if (result.error) {
      // Older installs may not have classified_by_audit_request_id —
      // retry without it so the wizard still works during deploy
      // window before the migration is applied.
      const msg = result.error.message ?? "";
      if (/classified_by_audit_request_id/.test(msg)) {
        delete update.classified_by_audit_request_id;
        let q2 = admin.from("brand_sellers").update(update).eq("brand_id", lead.brand_id);
        if (c.seller_id) q2 = q2.eq("seller_id", c.seller_id);
        else if (c.seller_name) q2 = q2.eq("seller_name", c.seller_name);
        result = await q2.select("id");
      }
      if (result.error) {
        console.error("[audit-flow/classify] update failed", result.error);
        return NextResponse.json({ error: result.error.message }, { status: 500 });
      }
    }
    if (Array.isArray(result.data)) updated += result.data.length;
  }

  await admin
    .from("leads")
    .update({
      audit_status: "classified",
      classification_completed_at: nowIso,
    })
    .eq("id", data.lead_id);

  return NextResponse.json({ ok: true, updated });
}
