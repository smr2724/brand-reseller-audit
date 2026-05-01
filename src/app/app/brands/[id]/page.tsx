import { createSupabaseServerClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import BrandDetailClient from "./BrandDetailClient";

export const dynamic = "force-dynamic";

export default async function BrandDetail({ params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: brand } = await supabase
    .from("brands")
    .select("*")
    .eq("id", params.id)
    .eq("user_id", user!.id)
    .maybeSingle();

  if (!brand) notFound();

  return (
    <div className="p-6 max-w-[1100px] mx-auto">
      <div className="mb-4">
        <Link href="/app/brands" className="text-sm text-[var(--text-muted)] hover:text-[var(--text)]">
          ← All brands
        </Link>
      </div>
      <BrandDetailClient brand={brand} />
    </div>
  );
}
