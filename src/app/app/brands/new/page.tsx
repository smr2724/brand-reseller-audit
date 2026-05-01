import AddBrandByName from "./AddBrandByName";

export const dynamic = "force-dynamic";

export default function NewBrandPage() {
  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Add Brand by Name</h1>
        <p className="text-sm text-[var(--text-muted)] mt-2">
          Search Keepa for an Amazon US brand by name. Pick the right
          match and we&rsquo;ll create it and run full Keepa + DataForSEO
          enrichment so you can generate a v2 audit immediately.
        </p>
      </div>
      <AddBrandByName />
    </div>
  );
}
