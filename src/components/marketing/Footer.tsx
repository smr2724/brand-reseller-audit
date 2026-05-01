import Link from "next/link";

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="m-footer">
      <div className="container">
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 32 }} className="m-footer-grid">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 28,
                  height: 28,
                  background: "#fff",
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
              <span style={{ fontSize: 18, color: "#fff", fontWeight: 600, letterSpacing: "-0.02em" }}>
                Rolle Consulting Group
              </span>
            </div>
            <p style={{ maxWidth: "44ch", color: "#a4adb8", lineHeight: 1.55, fontSize: 14 }}>
              Amazon channel ownership consulting for mid-market brands. We
              help you take the channel back from third-party resellers and
              double its contribution to enterprise value.
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
                <li><Link href="/contact">Contact</Link></li>
                <li><Link href="/partner">Partnerships</Link></li>
              </ul>
            </div>
            <div>
              <div style={{ color: "#fff", fontWeight: 600, fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 14 }}>
                Account
              </div>
              <ul style={{ display: "grid", gap: 10, listStyle: "none", padding: 0, margin: 0 }}>
                <li><Link href="/login">Log in</Link></li>
                <li><Link href="/contact">Get a free audit</Link></li>
              </ul>
            </div>
          </div>
        </div>

        <div className="row">
          <div>© {year} Rolle Consulting Group. All rights reserved.</div>
          <div>Operator-aligned. No retainer.</div>
        </div>
      </div>
    </footer>
  );
}
