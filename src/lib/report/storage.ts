import { createSupabaseAdminClient } from "@/lib/supabase/server";

const BUCKET = "reports";
const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
// 30-day URLs are used in outbound report-followup emails; a recipient
// who clicks ~3 weeks after Steve drops the draft should still see the PDF.
const EMAIL_SIGNED_URL_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function adminOrThrow() {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY missing — required for report storage operations");
  }
  return admin;
}

async function ensureBucket(): Promise<void> {
  const admin = adminOrThrow();
  try {
    const { data, error } = await admin.storage.getBucket(BUCKET);
    if (data) return;
    if (error && !/not found/i.test(error.message)) {
      // Some other error — try to create anyway.
    }
  } catch {
    // ignore
  }
  try {
    await admin.storage.createBucket(BUCKET, { public: false });
  } catch (e) {
    // If creation fails because it already exists, ignore. Otherwise rethrow.
    const msg = String((e as Error)?.message ?? e);
    if (!/exists/i.test(msg)) throw e;
  }
}

export async function uploadReportPdf(opts: {
  userId: string;
  brandId: string | null;
  reportId: string;
  buffer: Buffer;
}): Promise<{ path: string; signedUrl: string }> {
  await ensureBucket();
  const admin = adminOrThrow();

  const safeBrandId = opts.brandId ?? "unfiled";
  const path = `${opts.userId}/${safeBrandId}/${opts.reportId}.pdf`;

  const { error: upErr } = await admin.storage
    .from(BUCKET)
    .upload(path, opts.buffer, {
      contentType: "application/pdf",
      upsert: true,
    });
  if (upErr) throw new Error(`storage upload failed: ${upErr.message}`);

  const { data: signed, error: sErr } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (sErr || !signed?.signedUrl) {
    throw new Error(`signed url failed: ${sErr?.message ?? "no url"}`);
  }
  return { path, signedUrl: signed.signedUrl };
}

export async function freshSignedUrl(path: string): Promise<string> {
  const admin = adminOrThrow();
  const { data, error } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new Error(`signed url failed: ${error?.message ?? "no url"}`);
  }
  return data.signedUrl;
}

/**
 * Phase 6.5 — Sign a long-lived (default 30-day) URL specifically for
 * embedding in outbound emails. Distinct from the 7-day in-app URL so the
 * recipient still has a working link weeks later.
 */
export async function getReportLongLivedUrl(reportId: string, days = 30): Promise<string> {
  const admin = adminOrThrow();
  const { data: row, error: rowErr } = await admin
    .from("reports")
    .select("pdf_storage_path, status")
    .eq("id", reportId)
    .maybeSingle();
  if (rowErr) throw new Error(`report lookup failed: ${rowErr.message}`);
  if (!row) throw new Error("report not found");
  if (row.status !== "completed" || !row.pdf_storage_path) {
    throw new Error(`report not ready (${row.status ?? "unknown"})`);
  }
  const ttl = Math.max(60, Math.round(days * 24 * 60 * 60));
  const { data, error } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(row.pdf_storage_path, ttl);
  if (error || !data?.signedUrl) {
    throw new Error(`signed url failed: ${error?.message ?? "no url"}`);
  }
  return data.signedUrl;
}

// Re-exported for tests that want to confirm the email-TTL constant is
// long enough for the default 30-day window.
export { EMAIL_SIGNED_URL_TTL_SECONDS };
