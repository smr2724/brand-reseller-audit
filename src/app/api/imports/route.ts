import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { parseSmartScout } from "@/lib/importer/smartscout";
import { parseInitialTargets } from "@/lib/importer/initialTargets";
import { mergeBrands } from "@/lib/importer/merge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("imports")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ imports: data ?? [] });
}

export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  const sourceType = String(form.get("source_type") ?? "");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }
  if (sourceType !== "smartscout_raw" && sourceType !== "initial_targets_analysis") {
    return NextResponse.json({ error: "invalid source_type" }, { status: 400 });
  }

  const filename = file.name || "upload.xlsx";
  const buffer = Buffer.from(await file.arrayBuffer());

  const { data: importRow, error: insertErr } = await supabase
    .from("imports")
    .insert({
      user_id: user.id,
      filename,
      source_type: sourceType,
      status: "processing",
    })
    .select()
    .single();

  if (insertErr || !importRow) {
    return NextResponse.json({ error: insertErr?.message ?? "could not record import" }, { status: 500 });
  }

  try {
    const { data: overrides } = await supabase
      .from("import_column_mappings")
      .select("source_column,target_field")
      .eq("user_id", user.id)
      .eq("source_type", sourceType);

    const parsed =
      sourceType === "smartscout_raw"
        ? parseSmartScout(buffer, { overrides: overrides ?? [] })
        : parseInitialTargets(buffer, { overrides: overrides ?? [] });

    const result = await mergeBrands(supabase, user.id, parsed);

    await supabase
      .from("imports")
      .update({
        row_count: parsed.length,
        inserted_count: result.inserted,
        updated_count: result.updated,
        skipped_count: result.skipped,
        status: "completed",
      })
      .eq("id", importRow.id)
      .eq("user_id", user.id);

    return NextResponse.json({
      import_id: importRow.id,
      row_count: parsed.length,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "parse failed";
    await supabase
      .from("imports")
      .update({ status: "failed", error_message: msg })
      .eq("id", importRow.id)
      .eq("user_id", user.id);
    return NextResponse.json({ error: msg, import_id: importRow.id }, { status: 500 });
  }
}
