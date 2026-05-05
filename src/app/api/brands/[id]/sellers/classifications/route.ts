/**
 * Phase 39 — Persist seller classifications captured in the
 * SellerClassificationModal.
 *
 * Body shape:
 *   { classifications: [{ seller_id?: string|null, seller_name?: string|null, classification: 'brand_owned'|'authorized'|'amazon'|'reseller' }] }
 *
 * We match each classification to a brand_sellers row by (brand_id,
 * seller_id) when a seller_id is present, else by (brand_id,
 * lower(seller_name)). is_brand_controlled is mirrored so the existing
 * brand-page reseller widgets stay coherent.
 */
import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const VALID = new Set(["brand_owned", "authorized", "amazon", "reseller"]);

interface ClassificationInput {
  seller_id?: string | null;
  seller_name?: string | null;
  classification: string;
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: brand, error: brandErr } = await supabase
    .from("brands")
    .select("id")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (brandErr) {
    return NextResponse.json({ error: brandErr.message }, { status: 500 });
  }
  if (!brand) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    classifications?: ClassificationInput[];
  };
  const inputs = Array.isArray(body.classifications) ? body.classifications : null;
  if (!inputs || inputs.length === 0) {
    return NextResponse.json(
      { error: "classifications array required" },
      { status: 400 },
    );
  }

  for (const c of inputs) {
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
    return NextResponse.json(
      { error: "Server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  const nowIso = new Date().toISOString();
  let updated = 0;
  for (const c of inputs) {
    const update = {
      classification: c.classification,
      classified_by_user_id: user.id,
      classified_at: nowIso,
      // Mirror to is_brand_controlled so the existing dossier/reality
      // narratives + brand-page widgets keep agreeing with the user's
      // explicit verdict. Authorized/amazon both count as "not a
      // capture target" for those code paths.
      is_brand_controlled:
        c.classification === "brand_owned" || c.classification === "authorized",
    };

    let q = admin
      .from("brand_sellers")
      .update(update)
      .eq("brand_id", params.id);
    if (c.seller_id) {
      q = q.eq("seller_id", c.seller_id);
    } else if (c.seller_name) {
      q = q.eq("seller_name", c.seller_name);
    } else {
      // Skip rows with no identifier — nothing to match against.
      continue;
    }
    const { error: updErr, data } = await q.select("id");
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }
    if (Array.isArray(data)) updated += data.length;
  }

  return NextResponse.json({ ok: true, updated });
}
