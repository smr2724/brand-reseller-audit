import { notFound } from "next/navigation";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import Link from "next/link";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PageProps {
  params: { token: string };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  return {
    title: "Amazon Opportunity Report — Rolle Management Group",
    description: "A category-specific Amazon opportunity brief prepared by Rolle Management Group.",
    robots: { index: false, follow: false }, // private by URL
  };
}

export default async function ReportPage({ params }: PageProps) {
  const admin = createSupabaseAdminClient();
  if (!admin) return notFound();

  // Look up the report by token (public — token is the secret).
  const { data: report } = await admin
    .from("reports")
    .select("id, supplier_id, opportunity_id, created_at, views")
    .eq("token", params.token)
    .maybeSingle();

  if (!report) return notFound();

  // Increment view count (best-effort, don't block render)
  admin
    .from("reports")
    .update({ views: (report.views ?? 0) + 1, last_viewed_at: new Date().toISOString() })
    .eq("id", report.id)
    .then(() => {});

  // Fetch supplier + opportunity in parallel
  const [supRes, oppRes] = await Promise.all([
    admin
      .from("suppliers")
      .select(
        "id, company_name, domain, hq_city, hq_state, hq_country, description, product_lines, industries, founded_year, employee_estimate, sells_on_amazon"
      )
      .eq("id", report.supplier_id)
      .single(),
    admin
      .from("opportunities")
      .select(
        "id, name, main_keyword, category, monthly_search_volume, total_cluster_search_volume, top_10_avg_reviews, top_10_avg_rating, avg_price, recommended_path"
      )
      .eq("id", report.opportunity_id)
      .single(),
  ]);

  const supplier = supRes.data;
  const opportunity = oppRes.data;
  if (!supplier || !opportunity) {
    console.error("[report] missing data", {
      token: params.token,
      supplier_id: report.supplier_id,
      opportunity_id: report.opportunity_id,
      supErr: supRes.error?.message,
      oppErr: oppRes.error?.message,
      hasSupplier: !!supplier,
      hasOpportunity: !!opportunity,
    });
    return notFound();
  }

  // Pull the opportunity-supplier pair for fit narrative
  const { data: pair } = await admin
    .from("opportunity_suppliers")
    .select("fit_summary, why_excited, why_skeptical, outreach_angle, recommended_path")
    .eq("supplier_id", report.supplier_id)
    .eq("opportunity_id", report.opportunity_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const productCategory = opportunity.main_keyword || opportunity.name || "your category";
  const onAmazon = supplier.sells_on_amazon === true;

  // Topline numbers for the category (customer-friendly, no internal scores)
  const monthlySearches = opportunity.monthly_search_volume ?? null;
  const avgPrice = opportunity.avg_price ?? null;
  const avgReviews = opportunity.top_10_avg_reviews ?? null;
  const hasCategoryNumbers = monthlySearches || avgPrice || avgReviews;

  return (
    <div className="report-root">
      <ReportStyles />

      {/* Header */}
      <header className="r-hdr">
        <div className="container">
          <div className="r-hdr-row">
            <Link href="/" className="r-brand">
              <span className="r-bolt">⚡</span>
              <span>Rolle Management Group</span>
            </Link>
            <div className="r-hdr-right">Prepared for {supplier.company_name}</div>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="r-hero">
        <div className="container">
          <div className="eyebrow">Amazon opportunity report</div>
          <h1>
            The {productCategory} opportunity
            <br />
            <span className="r-h1-sub">— and why {supplier.company_name} could win it.</span>
          </h1>
          <p className="lede">
            We track underdeveloped Amazon categories where customer demand is real but the marketplace
            execution is weak. {productCategory} is one of them. This brief lays out what we&apos;re
            seeing in the category, why your company stood out as a fit, and how a partnership could be
            structured.
          </p>
        </div>
      </section>

      {/* What we&apos;re seeing */}
      <section className="r-section">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">What we&apos;re seeing in the category</div>
            <h2>Real demand. Weak execution.</h2>
            <p className="lede">
              Customers are actively searching for {productCategory} on Amazon. The listings winning
              that traffic today are not category-leading products — they&apos;re category-leading
              <em> sellers</em>. Whoever shows up every day, runs the listing well, and protects the
              brand wins. Most established manufacturers in this space are simply not in the
              conversation.
            </p>
          </div>

          {hasCategoryNumbers && (
            <div className="r-evidence">
              <div className="r-evidence-label">What the category looks like today</div>
              <div className="r-cat-stats">
                {monthlySearches && (
                  <div className="r-cat-stat">
                    <div className="r-cat-num">{Number(monthlySearches).toLocaleString()}</div>
                    <div className="r-cat-lbl">Monthly searches on Amazon for &ldquo;{productCategory}&rdquo;</div>
                  </div>
                )}
                {avgPrice && (
                  <div className="r-cat-stat">
                    <div className="r-cat-num">${Number(avgPrice).toFixed(2)}</div>
                    <div className="r-cat-lbl">Average price of top-ranking listings</div>
                  </div>
                )}
                {avgReviews && (
                  <div className="r-cat-stat">
                    <div className="r-cat-num">{Math.round(Number(avgReviews)).toLocaleString()}</div>
                    <div className="r-cat-lbl">Average review count of the top 10 listings</div>
                  </div>
                )}
              </div>
              <p className="r-evidence-note">
                None of the listings winning this traffic today benefit from the manufacturing
                pedigree, quality control, or product expertise that {supplier.company_name} brings.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Why this supplier */}
      <section className="r-section r-section-alt">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">Why {supplier.company_name}</div>
            <h2>You already make the product.</h2>
            <p className="lede">
              {supplier.description ||
                `${supplier.company_name} is exactly the type of company we partner with — established product capability, strong reputation, but missing from a category where customers are looking right now.`}
            </p>
          </div>

          <div className="r-fit-grid">
            {pair?.fit_summary && (
              <div className="r-fit-card r-fit-primary">
                <div className="r-fit-label">The fit, in one paragraph</div>
                <p>{pair.fit_summary}</p>
              </div>
            )}
            {pair?.why_excited && (
              <div className="r-fit-card">
                <div className="r-fit-label r-fit-pos">Why we think this works</div>
                <p>{pair.why_excited}</p>
              </div>
            )}
            {pair?.why_skeptical && (
              <div className="r-fit-card">
                <div className="r-fit-label r-fit-neg">What we&apos;d want to validate</div>
                <p>{pair.why_skeptical}</p>
              </div>
            )}
          </div>

          <div className="r-supplier-facts">
            {supplier.product_lines && supplier.product_lines.length > 0 && (
              <Fact label="Product lines" value={(supplier.product_lines as string[]).join(", ")} />
            )}
            {supplier.industries && supplier.industries.length > 0 && (
              <Fact label="Industries" value={(supplier.industries as string[]).join(", ")} />
            )}
            {supplier.founded_year && <Fact label="Founded" value={String(supplier.founded_year)} />}
            {supplier.hq_city && (
              <Fact
                label="HQ"
                value={[supplier.hq_city, supplier.hq_state, supplier.hq_country]
                  .filter(Boolean)
                  .join(", ")}
              />
            )}
            <Fact label="Currently on Amazon" value={onAmazon ? "Yes — limited" : "No"} />
          </div>
        </div>
      </section>

      {/* Three partnership models */}
      <section className="r-section">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">How a partnership could work</div>
            <h2>Three ways we partner.</h2>
            <p className="lede">
              We meet you where you are. Whichever of these fits your business, we run the Amazon side
              of it.
            </p>
          </div>

          <div className="m-grid-3">
            <div className="m-card r-model">
              <div className="r-model-tag">Model 1</div>
              <h3>Done-for-you operations</h3>
              <p>
                We run Amazon under your brand. Listings, brand store, content, A+, PPC, inventory,
                customer service, brand protection — all of it. You ship product, we run the channel.
              </p>
            </div>
            <div className="m-card r-model">
              <div className="r-model-tag">Model 2</div>
              <h3>Wholesale or private label</h3>
              <p>
                We buy product from you wholesale and sell it on Amazon ourselves — either under
                your brand with your blessing, or under a private label we own. You get incremental
                volume with zero operational lift.
              </p>
            </div>
            <div className="m-card r-model">
              <div className="r-model-tag">Model 3</div>
              <h3>Authorized reseller</h3>
              <p>
                We become your authorized Amazon reseller. We protect the brand, enforce MAP, shut
                down rogue listings, and hold the buy-box at the price you want.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Track record */}
      <section className="r-section r-section-alt">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">Track record</div>
            <h2>$60M+ lifetime, niche categories that other operators ignore.</h2>
          </div>
          <div className="m-stats">
            <div className="m-stat">
              <div className="num">$60M+</div>
              <div className="lbl">Lifetime Amazon sales operated across partner brands</div>
            </div>
            <div className="m-stat">
              <div className="num">$10M / yr</div>
              <div className="lbl">Hospitality consumables grown from $0 in 6 years (DHS)</div>
            </div>
            <div className="m-stat">
              <div className="num">$1M+ ARR</div>
              <div className="lbl">Built on Legion Chemicals in 10 months from launch</div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="r-cta">
        <div className="container">
          <h2>Want to see what this looks like for {supplier.company_name}?</h2>
          <p className="lede">
            Reply to the email this report came in on, or reach out directly:
          </p>
          <p className="r-cta-contact">
            <a href="mailto:steve@rollemanagementgroup.com">steve@rollemanagementgroup.com</a>
            <br />
            Steve Rolle, Founder · Rolle Management Group
          </p>
          <Link href="/" className="m-btn">
            More on how we work →
          </Link>
        </div>
      </section>

      <footer className="r-footer">
        <div className="container">
          <div>© {new Date().getFullYear()} Rolle Management Group · Confidential brief prepared for {supplier.company_name}</div>
        </div>
      </footer>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="r-fact">
      <div className="r-fact-label">{label}</div>
      <div className="r-fact-value">{value}</div>
    </div>
  );
}

function ReportStyles() {
  return (
    <style>{`
      .report-root {
        --bg: #0b0b0d;
        --bg-alt: #111114;
        --text: #f2f2f3;
        --text-muted: #9b9ba3;
        --gold: #d4a850;
        --gold-soft: #f4d188;
        --border: rgba(255,255,255,0.08);
        --border-soft: rgba(255,255,255,0.06);
        background: var(--bg);
        color: var(--text);
        min-height: 100vh;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        line-height: 1.55;
      }
      .report-root .container { max-width: 1100px; margin: 0 auto; padding: 0 24px; }

      .report-root .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font-size: 12px;
        color: var(--gold);
        font-weight: 600;
      }
      .report-root h1, .report-root h2, .report-root h3 { color: var(--text); margin: 0; }
      .report-root h1 { font-size: 44px; line-height: 1.1; font-weight: 700; letter-spacing: -0.02em; }
      .report-root h2 { font-size: 30px; line-height: 1.2; font-weight: 700; letter-spacing: -0.01em; margin-bottom: 12px; }
      .report-root h3 { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
      .report-root .lede { font-size: 18px; color: var(--text-muted); max-width: 720px; }
      .report-root .r-h1-sub { color: var(--gold-soft); font-weight: 500; }

      .r-hdr { padding: 20px 0; border-bottom: 1px solid var(--border-soft); }
      .r-hdr-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
      .r-brand { display: inline-flex; align-items: center; gap: 8px; color: var(--text); text-decoration: none; font-weight: 600; }
      .r-bolt { color: var(--gold); font-size: 16px; }
      .r-hdr-right { color: var(--text-muted); font-size: 13px; }

      .r-hero { padding: 80px 0 56px; }
      .r-hero h1 { margin-top: 18px; }
      .r-hero .lede { margin-top: 28px; }

      .r-section { padding: 64px 0; border-top: 1px solid var(--border-soft); }
      .r-section-alt { background: var(--bg-alt); }
      .m-section-head { max-width: 820px; margin-bottom: 36px; }

      .report-root .m-grid-3 {
        display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;
      }
      @media (max-width: 800px) { .report-root .m-grid-3 { grid-template-columns: 1fr; } }
      .report-root .m-card {
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.02);
        padding: 24px;
        border-radius: 12px;
      }
      .report-root .m-card p { color: var(--text-muted); margin: 8px 0 0; }
      .r-model-tag {
        display: inline-block; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
        color: var(--gold); margin-bottom: 8px; font-weight: 600;
      }

      .r-evidence { margin-top: 24px; padding: 24px; background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 12px; }
      .r-evidence-label { color: var(--text-muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px; }
      .r-listings { list-style: none; padding: 0; margin: 0 0 12px; }
      .r-listings li { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border-soft); align-items: baseline; flex-wrap: wrap; }
      .r-listings li:last-child { border-bottom: none; }
      .r-listing-num { color: var(--gold); font-weight: 600; min-width: 24px; }
      .r-listing-title { flex: 1; min-width: 220px; }
      .r-listing-brand { color: var(--text-muted); font-size: 13px; }
      .r-listing-price { color: var(--gold-soft); font-size: 13px; font-variant-numeric: tabular-nums; }
      .r-evidence-note { color: var(--text-muted); font-size: 14px; margin: 12px 0 0; font-style: italic; }

      .r-cat-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
      .r-cat-stat { padding: 16px; border: 1px solid var(--border-soft); border-radius: 10px; background: rgba(255,255,255,0.02); }
      .r-cat-num { color: var(--gold); font-size: 26px; font-weight: 700; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
      .r-cat-lbl { color: var(--text-muted); font-size: 13px; margin-top: 4px; }

      .r-fit-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin: 32px 0 24px; }
      .r-fit-primary { grid-column: 1 / -1; }
      @media (max-width: 800px) { .r-fit-grid { grid-template-columns: 1fr; } }
      .r-fit-card {
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.02);
        padding: 22px;
        border-radius: 12px;
      }
      .r-fit-card p { margin: 8px 0 0; color: var(--text); }
      .r-fit-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); font-weight: 600; }
      .r-fit-pos { color: #86efac; }
      .r-fit-neg { color: #fdba74; }

      .r-supplier-facts {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px; margin-top: 16px;
      }
      .r-fact { padding: 12px 14px; border: 1px solid var(--border-soft); border-radius: 10px; background: rgba(255,255,255,0.015); }
      .r-fact-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }
      .r-fact-value { font-size: 13px; color: var(--text); }

      .report-root .m-stats {
        display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 8px;
      }
      @media (max-width: 800px) { .report-root .m-stats { grid-template-columns: 1fr; } }
      .report-root .m-stat {
        border: 1px solid var(--border);
        padding: 24px;
        border-radius: 12px;
        background: rgba(255,255,255,0.02);
      }
      .report-root .m-stat .num { color: var(--gold); font-size: 32px; font-weight: 700; letter-spacing: -0.01em; }
      .report-root .m-stat .lbl { color: var(--text-muted); font-size: 13px; margin-top: 4px; }

      .r-cta { padding: 80px 0; text-align: center; border-top: 1px solid var(--border-soft); }
      .r-cta h2 { margin-bottom: 12px; }
      .r-cta .lede { margin: 0 auto 16px; }
      .r-cta-contact { font-size: 16px; color: var(--text); margin: 16px auto 32px; line-height: 1.7; }
      .r-cta-contact a { color: var(--gold); text-decoration: none; }
      .r-cta-contact a:hover { text-decoration: underline; }
      .report-root .m-btn {
        display: inline-block; padding: 14px 24px; border-radius: 10px;
        background: var(--gold); color: #1a1408; font-weight: 600; text-decoration: none; font-size: 15px;
      }
      .report-root .m-btn:hover { background: var(--gold-soft); }

      .r-footer { padding: 32px 0; border-top: 1px solid var(--border-soft); color: var(--text-muted); font-size: 13px; text-align: center; }
    `}</style>
  );
}
