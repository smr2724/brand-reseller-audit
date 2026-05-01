import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LeadSchema = z.object({
  brand_name: z.string().trim().min(1).max(200),
  contact_name: z.string().trim().max(200).nullable().optional(),
  email: z.string().trim().email().max(320),
  website: z.string().trim().max(500).nullable().optional(),
  wholesale_price: z.number().finite().nonnegative().nullable().optional(),
  note: z.string().trim().max(5000).nullable().optional(),
  source_page: z.string().trim().max(200).nullable().optional(),
  utm_source: z.string().trim().max(200).nullable().optional(),
  utm_medium: z.string().trim().max(200).nullable().optional(),
  utm_campaign: z.string().trim().max(200).nullable().optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = LeadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    console.error("[leads] missing SUPABASE_SERVICE_ROLE_KEY");
    return NextResponse.json(
      { error: "Service is not configured" },
      { status: 500 }
    );
  }

  const { error } = await admin.from("leads").insert({
    brand_name: parsed.data.brand_name,
    contact_name: parsed.data.contact_name ?? null,
    email: parsed.data.email,
    website: parsed.data.website ?? null,
    wholesale_price: parsed.data.wholesale_price ?? null,
    note: parsed.data.note ?? null,
    source_page: parsed.data.source_page ?? null,
    utm_source: parsed.data.utm_source ?? null,
    utm_medium: parsed.data.utm_medium ?? null,
    utm_campaign: parsed.data.utm_campaign ?? null,
  });

  if (error) {
    console.error("[leads] insert failed", error);
    return NextResponse.json(
      { error: "Could not save submission" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
