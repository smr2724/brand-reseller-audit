import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { randomBytes } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  supplier_id: string;
  opportunity_id: string;
}

function makeToken(): string {
  // 32 url-safe characters, ~190 bits of entropy
  return randomBytes(24).toString("base64url");
}

export async function POST(req: NextRequest) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { supplier_id, opportunity_id } = (await req.json()) as Body;
  if (!supplier_id || !opportunity_id) {
    return NextResponse.json({ error: "supplier_id and opportunity_id required" }, { status: 400 });
  }

  // Sanity: confirm both belong to this user
  const [supRes, oppRes] = await Promise.all([
    supabase.from("suppliers").select("id").eq("id", supplier_id).eq("user_id", user.id).single(),
    supabase.from("opportunities").select("id").eq("id", opportunity_id).eq("user_id", user.id).single(),
  ]);
  if (!supRes.data) return NextResponse.json({ error: "Supplier not found" }, { status: 404 });
  if (!oppRes.data) return NextResponse.json({ error: "Opportunity not found" }, { status: 404 });

  // If a report already exists for this pair, reuse it (idempotent).
  const { data: existing } = await supabase
    .from("reports")
    .select("id, token")
    .eq("supplier_id", supplier_id)
    .eq("opportunity_id", opportunity_id)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ||
      "https://legion-opportunity-scanner.vercel.app";
    return NextResponse.json({
      token: existing.token,
      url: `${baseUrl}/r/${existing.token}`,
      reused: true,
    });
  }

  const token = makeToken();
  const { error } = await supabase.from("reports").insert({
    user_id: user.id,
    supplier_id,
    opportunity_id,
    token,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ||
    "https://legion-opportunity-scanner.vercel.app";

  return NextResponse.json({
    token,
    url: `${baseUrl}/r/${token}`,
    reused: false,
  });
}
