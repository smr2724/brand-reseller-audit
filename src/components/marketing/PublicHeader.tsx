"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Home" },
  { href: "/about", label: "About" },
  { href: "/case-studies", label: "Case Studies" },
  { href: "/contact", label: "Contact" },
];

export default function PublicHeader() {
  const pathname = usePathname();
  return (
    <nav className="m-nav">
      <div className="container m-nav-inner">
        <Link href="/" aria-label="Rolle Consulting Group — Home" className="m-logo">
          <span
            aria-hidden
            style={{
              display: "inline-block",
              width: 28,
              height: 28,
              background: "var(--m-ink)",
              borderRadius: 2,
              position: "relative",
            }}
          >
            <span
              style={{
                position: "absolute",
                inset: 6,
                background: "var(--m-accent)",
                borderRadius: 1,
              }}
            />
          </span>
          <span>Rolle Consulting Group</span>
        </Link>

        <div className="m-nav-links">
          {links.map((l) => {
            const active =
              l.href === "/"
                ? pathname === "/"
                : pathname === l.href || pathname?.startsWith(l.href + "/");
            return (
              <Link key={l.href} href={l.href} className={active ? "active" : ""}>
                {l.label}
              </Link>
            );
          })}
          <Link
            href="/login"
            className="m-btn m-btn-outline"
            style={{ padding: "10px 18px", fontSize: 13 }}
          >
            Log in
          </Link>
        </div>

        <Link
          href="/login"
          className="m-btn m-btn-outline m-nav-mobile-cta"
          style={{ padding: "9px 14px", fontSize: 13 }}
        >
          Log in
        </Link>
      </div>
    </nav>
  );
}
