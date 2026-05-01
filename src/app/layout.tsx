import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

// TODO: add OG image
export const metadata: Metadata = {
  title: "Rolle Consulting Group — Amazon Channel Ownership Audits",
  description:
    "We help mid-market brands take back their Amazon channel from third-party resellers — and double its contribution to enterprise value. Free audit. No upfront cost.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#0b0d10",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
