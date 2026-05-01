import Link from "next/link";

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="m-footer">
      <div className="container">
        <div className="m-footer-grid">
          <div>
            <div className="wordmark">Rolle Consulting Group</div>
            <p className="tagline">
              The operator-led consultancy for mid-market brands taking their
              Amazon channel back from third-party resellers.
            </p>
            <div style={{ marginTop: 22 }}>
              <Link href="/contact" className="m-btn m-btn-light" style={{ padding: "11px 18px", fontSize: 13 }}>
                Free audit →
              </Link>
            </div>
          </div>

          <div>
            <h4>Company</h4>
            <ul>
              <li><Link href="/about">About</Link></li>
              <li><Link href="/case-studies">Case Studies</Link></li>
              <li><Link href="/partner">Partner</Link></li>
              <li><Link href="/contact">Contact</Link></li>
            </ul>
          </div>

          <div>
            <h4>Account</h4>
            <ul>
              <li><Link href="/login">Log in</Link></li>
              <li><Link href="/contact">Get a free audit</Link></li>
            </ul>
          </div>
        </div>

        <div className="m-footer-row">
          <div>© {year} Rolle Consulting Group. All rights reserved.</div>
          <div>Aligned incentives. No retainer. Operator-led.</div>
        </div>
      </div>
    </footer>
  );
}
