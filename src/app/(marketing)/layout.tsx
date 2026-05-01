import type { Metadata } from "next";
import PublicHeader from "@/components/marketing/PublicHeader";
import Footer from "@/components/marketing/Footer";

export const metadata: Metadata = {
  title: "Rolle Consulting Group — Amazon Channel Ownership Audits",
  description:
    "We help mid-market brands take back their Amazon channel from third-party resellers — and double its contribution to enterprise value. Free audit. No upfront cost.",
};

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="marketing-root">
      <PublicHeader />
      <main>{children}</main>
      <Footer />
    </div>
  );
}
