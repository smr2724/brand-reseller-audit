import { createSupabaseAdminClient } from "@/lib/supabase/server";

const BUCKET = "reports";
const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

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
