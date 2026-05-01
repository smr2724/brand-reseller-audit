import type { Metadata } from "next";
import Nav from "@/components/marketing/Nav";
import Footer from "@/components/marketing/Footer";

export const metadata: Metadata = {
  title: "Rolle Management Group — Build the e-commerce engine around your product",
  description:
    "We partner with established manufacturers to find overlooked niche e-commerce opportunities, then build and operate the Amazon marketplace engine needed to turn proven products into category leaders.",
};

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="marketing-root">
      <Nav />
      <main>{children}</main>
      <Footer />
    </div>
  );
}
