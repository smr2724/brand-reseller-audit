"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const links = [
  { href: "/", label: "Home" },
  { href: "/about", label: "About" },
  { href: "/case-studies", label: "Case Studies" },
  { href: "/contact", label: "Contact" },
];

function Wordmark() {
  return (
    <span className="m-logo" aria-label="Rolle Consulting Group — Home">
      <span aria-hidden className="m-logo-mark">
        <svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="0.5" y="0.5" width="29" height="29" stroke="#0B1220" />
          <rect x="9" y="9" width="12" height="12" fill="#D4B36A" />
        </svg>
      </span>
      <span style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 400, letterSpacing: "-0.005em", fontSize: 17 }}>
        Rolle Consulting Group
      </span>
    </span>
  );
}

export default function PublicHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <nav className="m-nav" aria-label="Primary">
        <div className="container m-nav-inner">
          <Link href="/">
            <Wordmark />
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
              style={{ fontSize: 13, color: "var(--color-muted)" }}
            >
              Log in
            </Link>
            <Link
              href="/contact"
              className="m-btn"
              style={{ padding: "11px 18px", fontSize: 13 }}
            >
              Free audit
            </Link>
          </div>

          <button
            type="button"
            className="m-nav-burger"
            aria-label="Open menu"
            aria-expanded={open}
            aria-controls="m-nav-overlay"
            onClick={() => setOpen(true)}
          >
            <svg width="20" height="14" viewBox="0 0 20 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
              <path d="M0 1H20" stroke="currentColor" strokeWidth="1.5" />
              <path d="M0 7H20" stroke="currentColor" strokeWidth="1.5" />
              <path d="M0 13H20" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
      </nav>

      {open && (
        <div className="m-nav-overlay" id="m-nav-overlay" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="m-nav-overlay-top">
            <Wordmark />
            <button
              type="button"
              className="m-nav-burger"
              aria-label="Close menu"
              onClick={() => setOpen(false)}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
                <path d="M1 1L17 17M17 1L1 17" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
          </div>
          <div className="m-nav-overlay-links">
            {links.map((l) => (
              <Link key={l.href} href={l.href}>
                {l.label}
              </Link>
            ))}
            <Link href="/partner">Partner</Link>
          </div>
          <div className="m-nav-overlay-foot">
            <Link href="/contact" className="m-btn" style={{ flex: 1 }}>
              Get a free audit
            </Link>
            <Link
              href="/login"
              className="m-btn m-btn-outline"
              style={{ flex: "0 1 auto" }}
            >
              Log in
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
