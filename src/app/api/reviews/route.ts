import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const VALID_DECISIONS = new Set(["qualified", "disqualified", "needs_research", "skip"]);
const VALID_REASONS = new Set([
  "foreign_hq",
  "chinese_drop_shipper",
  "amazon_owned",
  "amazon_1p_vendor",
  "too_generic",
  "too_large",
  "no_contact_path",
  "bad_website",
  "already_client",
  "other",
]);

const DECISION_TO_STATUS: Record<string, string | null> = {
  qualified: "qualified",
  disqualified: "disqualified",
  needs_research: "needs_research",
  skip: null,
};

export async function GET(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const brandId = url.searchParams.get("brand_id");
  if (!brandId) return NextResponse.json({ error: "brand_id required" }, { status: 400 });

  const { data, error } = await supabase
    .from("brand_reviews")
    .select("*")
    .eq("user_id", user.id)
    .eq("brand_id", brandId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ reviews: data ?? [] });
}

export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const brand_id: string | undefined = body.brand_id;
  const decision: string | undefined = body.decision;
  const disqualifier_reason: string | null = body.disqualifier_reason ?? null;
  const note: string | null = body.note ?? null;

  if (!brand_id || typeof brand_id !== "string") {
    return NextResponse.json({ error: "brand_id required" }, { status: 400 });
  }
  if (!decision || !VALID_DECISIONS.has(decision)) {
    return NextResponse.json({ error: "invalid decision" }, { status: 400 });
  }
  if (decision === "disqualified") {
    if (!disqualifier_reason || !VALID_REASONS.has(disqualifier_reason)) {
      return NextResponse.json({ error: "invalid disqualifier_reason" }, { status: 400 });
    }
  }

  // Load current brand row (RLS scopes by user).
  const { data: brand, error: brandErr } = await supabase
    .from("brands")
    .select("id, status, disqualifier_tags, review_count")
    .eq("id", brand_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (brandErr) return NextResponse.json({ error: brandErr.message }, { status: 500 });
  if (!brand) return NextResponse.json({ error: "brand not found" }, { status: 404 });

  // Insert review row.
  const { data: review, error: insErr } = await supabase
    .from("brand_reviews")
    .insert({
      user_id: user.id,
      brand_id,
      decision,
      disqualifier_reason: decision === "disqualified" ? disqualifier_reason : null,
      note: note ? String(note).slice(0, 4000) : null,
    })
    .select()
    .single();
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  // Update brand counters / status / tags.
  const newStatus = DECISION_TO_STATUS[decision];
  const update: Record<string, unknown> = {
    last_reviewed_at: new Date().toISOString(),
    review_count: (brand.review_count ?? 0) + 1,
    updated_at: new Date().toISOString(),
  };
  if (newStatus) update.status = newStatus;

  if (decision === "disqualified" && disqualifier_reason) {
    const existing: string[] = brand.disqualifier_tags ?? [];
    if (!existing.includes(disqualifier_reason)) {
      update.disqualifier_tags = [...existing, disqualifier_reason];
    }
  }

  const { data: updated, error: updErr } = await supabase
    .from("brands")
    .update(update)
    .eq("id", brand_id)
    .eq("user_id", user.id)
    .select()
    .single();
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ review, brand: updated });
}

export async function DELETE(req: Request) {
  // Undo: delete a brand_reviews row and revert brand status to the prior decision (if any).
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const reviewId = url.searchParams.get("id");
  if (!reviewId) return NextResponse.json({ error: "id required" }, { status: 400 });

  // Fetch the review we're undoing.
  const { data: review, error: revErr } = await supabase
    .from("brand_reviews")
    .select("*")
    .eq("id", reviewId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (revErr) return NextResponse.json({ error: revErr.message }, { status: 500 });
  if (!review) return NextResponse.json({ error: "review not found" }, { status: 404 });

  // Find the previous review for this brand (if any) — that's the status we revert to.
  const { data: prior } = await supabase
    .from("brand_reviews")
    .select("*")
    .eq("user_id", user.id)
    .eq("brand_id", review.brand_id)
    .lt("created_at", review.created_at)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Delete the review.
  const { error: delErr } = await supabase
    .from("brand_reviews")
    .delete()
    .eq("id", reviewId)
    .eq("user_id", user.id);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  // Determine prior status. If no prior decided review, revert to "new".
  let priorStatus = "new";
  if (prior && prior.decision !== "skip") {
    const map = DECISION_TO_STATUS[prior.decision];
    if (map) priorStatus = map;
  }

  // Load current brand to fix counters/tags.
  const { data: brand } = await supabase
    .from("brands")
    .select("id, disqualifier_tags, review_count")
    .eq("id", review.brand_id)
    .eq("user_id", user.id)
    .maybeSingle();

  const update: Record<string, unknown> = {
    status: priorStatus,
    review_count: Math.max(0, (brand?.review_count ?? 1) - 1),
    last_reviewed_at: prior?.created_at ?? null,
    updated_at: new Date().toISOString(),
  };

  // If we're undoing a disqualified decision, drop that reason from tags
  // (only if no other remaining review for this brand uses the same reason).
  if (review.decision === "disqualified" && review.disqualifier_reason && brand) {
    const existing: string[] = brand.disqualifier_tags ?? [];
    const reason = review.disqualifier_reason;
    const { data: stillReferenced } = await supabase
      .from("brand_reviews")
      .select("id")
      .eq("user_id", user.id)
      .eq("brand_id", review.brand_id)
      .eq("disqualifier_reason", reason)
      .limit(1);
    if (!stillReferenced || stillReferenced.length === 0) {
      update.disqualifier_tags = existing.filter((t) => t !== reason);
    }
  }

  const { data: updated, error: updErr } = await supabase
    .from("brands")
    .update(update)
    .eq("id", review.brand_id)
    .eq("user_id", user.id)
    .select()
    .single();
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, brand: updated });
}
