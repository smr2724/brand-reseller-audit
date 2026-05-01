import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { TARGET_FIELDS } from "@/lib/importer/mapper";

export const dynamic = "force-dynamic";

const VALID_SOURCES = new Set(["smartscout_raw", "initial_targets_analysis"]);

export async function GET(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const sourceType = url.searchParams.get("source_type") ?? "";
  if (!VALID_SOURCES.has(sourceType)) {
    return NextResponse.json({ error: "invalid source_type" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("import_column_mappings")
    .select("*")
    .eq("user_id", user.id)
    .eq("source_type", sourceType);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ mappings: data ?? [] });
}

export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const sourceType = String(body?.source_type ?? "");
  const sourceColumn = String(body?.source_column ?? "").trim();
  const targetField = String(body?.target_field ?? "").trim();

  if (!VALID_SOURCES.has(sourceType)) {
    return NextResponse.json({ error: "invalid source_type" }, { status: 400 });
  }
  if (!sourceColumn) {
    return NextResponse.json({ error: "source_column required" }, { status: 400 });
  }
  if (targetField !== "ignore" && !(TARGET_FIELDS as readonly string[]).includes(targetField)) {
    return NextResponse.json({ error: "invalid target_field" }, { status: 400 });
  }

  const { error } = await supabase
    .from("import_column_mappings")
    .upsert(
      {
        user_id: user.id,
        source_type: sourceType,
        source_column: sourceColumn,
        target_field: targetField,
      },
      { onConflict: "user_id,source_type,source_column" }
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
