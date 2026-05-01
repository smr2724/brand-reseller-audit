import ContactsTable from "./ContactsTable";

export const dynamic = "force-dynamic";

export default function ContactsPage() {
  return (
    <div className="p-6 max-w-[1300px] mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Contacts</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          Decision-makers discovered via Apollo, scoped to your brands.
        </p>
      </div>
      <ContactsTable />
    </div>
  );
}
