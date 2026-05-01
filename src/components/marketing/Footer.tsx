import Link from "next/link";
import Image from "next/image";

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="m-footer">
      <div className="container">
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 32 }} className="m-footer-grid">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <Image
                src="/rmg-logo-white.png"
                alt=""
                width={36}
                height={36}
                style={{ width: 36, height: 36, display: "block", objectFit: "contain" }}
              />
              <span style={{ fontSize: 18, color: "#fff", fontWeight: 600, letterSpacing: "-0.02em" }}>
                Rolle Management Group
              </span>
            </div>
            <p style={{ maxWidth: "44ch", color: "#a4adb8", lineHeight: 1.55, fontSize: 14 }}>
              We partner with established manufacturers to find overlooked
              niche e-commerce opportunities, then build and operate the
              Amazon marketplace engine around them.
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 32 }}>
            <div>
              <div style={{ color: "#fff", fontWeight: 600, fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 14 }}>
                Company
              </div>
              <ul style={{ display: "grid", gap: 10, listStyle: "none", padding: 0, margin: 0 }}>
                <li><Link href="/about">About</Link></li>
                <li><Link href="/case-studies">Case Studies</Link></li>
                <li><Link href="/partner">Partner With Us</Link></li>
                <li><Link href="/contact">Contact</Link></li>
              </ul>
            </div>
            <div>
              <div style={{ color: "#fff", fontWeight: 600, fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 14 }}>
                Team
              </div>
              <ul style={{ display: "grid", gap: 10, listStyle: "none", padding: 0, margin: 0 }}>
                <li><Link href="/login">Team Login</Link></li>
                <li>
                  <a href="mailto:steve@rollemanagementgroup.com">steve@rollemanagementgroup.com</a>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="row">
          <div>© {year} Rolle Management Group. All rights reserved.</div>
          <div>Built for operators, not for show.</div>
        </div>
      </div>
    </footer>
  );
}
