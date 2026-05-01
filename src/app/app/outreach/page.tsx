import OutreachQueue from "./OutreachQueue";

export const dynamic = "force-dynamic";

export default function OutreachPage() {
  return (
    <div className="p-6 max-w-[1300px] mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Outreach</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          Drafts are copy-only. No automated send. Paste into Outlook manually.
        </p>
      </div>
      <OutreachQueue />
    </div>
  );
}
