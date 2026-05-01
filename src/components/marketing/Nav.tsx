"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Logo from "./Logo";

const links = [
  { href: "/about", label: "About" },
  { href: "/case-studies", label: "Case Studies" },
  { href: "/partner", label: "Partner With Us" },
  { href: "/contact", label: "Contact" },
];

export default function Nav() {
  const pathname = usePathname();
  return (
    <nav className="m-nav">
      <div className="container m-nav-inner">
        <Link href="/" aria-label="Rolle Management Group — Home">
          <Logo />
        </Link>

        {/* Desktop links */}
        <div className="m-nav-links">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={pathname === l.href ? "active" : ""}
            >
              {l.label}
            </Link>
          ))}
          <Link
            href="/login"
            className="m-btn m-btn-outline"
            style={{ padding: "10px 18px", fontSize: 13 }}
          >
            Team Login
          </Link>
        </div>

        {/* Mobile login (visible when nav links collapse) */}
        <Link
          href="/login"
          className="m-btn m-btn-outline m-nav-mobile-cta"
          style={{ padding: "9px 14px", fontSize: 13 }}
        >
          Login
        </Link>
      </div>
    </nav>
  );
}
