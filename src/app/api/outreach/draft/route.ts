import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { generateOutreachDraftVariants, TONES, type Tone } from "@/lib/outreach/draft";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const brandId: string | undefined = body.brand_id;
  const contactId: string | undefined = body.contact_id;
  const tone: Tone | undefined = TONES.includes(body.tone) ? body.tone : undefined;
  const reportId: string | null = body.include_report_id ?? null;

  if (!brandId || !contactId) {
    return NextResponse.json({ error: "brand_id and contact_id required" }, { status: 400 });
  }

  const [{ data: brand }, { data: contact }] = await Promise.all([
    supabase
      .from("brands")
      .select("id, name, category, est_monthly_revenue, trailing_12_months, dominant_seller_sales_pct, dominant_seller_name, dominant_seller_country, total_products, avg_sellers")
      .eq("id", brandId)
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("contacts")
      .select("id, full_name, first_name, last_name, title")
      .eq("id", contactId)
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  if (!brand) return NextResponse.json({ error: "brand not found" }, { status: 404 });
  if (!contact) return NextResponse.json({ error: "contact not found" }, { status: 404 });

  const bundle = await generateOutreachDraftVariants({
    brand: brand as any,
    contact: contact as any,
    tone,
    reportId,
  });

  return NextResponse.json({
    variants: bundle.variants,
    signal_used: bundle.signal_used,
    model: bundle.model,
    default_tone: tone ?? "direct",
  });
}
