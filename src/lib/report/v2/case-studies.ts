/**
 * Phase 44 — single source of truth for the Diversified Hospitality
 * case study. All long-form mentions in the report (web + PDF) read
 * from here so there is exactly one canonical copy. Earlier mentions
 * elsewhere in the report use the short `snippets` map and link to
 * the appendix anchor (`case-study-diversified-hospitality`).
 *
 * The canonical copy is verbatim from
 * `/home/user/workspace/diversified_hospitality_case_study.md` — do
 * not paraphrase, condense, or rewrite. LLM prompts must instruct the
 * model to reference but never regenerate the case-study text.
 */

export const CASE_STUDY_ANCHOR_ID = "case-study-diversified-hospitality";

export type CaseStudyParagraphLines = {
  /** Heading paragraph for this section. */
  lead?: string;
  /** Inline paragraphs that flow as normal prose blocks. */
  paragraphs?: string[];
  /** Bullet-style lines preserved from the source markdown. */
  bullets?: string[];
  /** Trailing paragraphs after the bullets. */
  tail?: string[];
};

export type DiversifiedCaseStudy = {
  preface: string;
  headline: string;
  sections: {
    situation: CaseStudyParagraphLines;
    decision: CaseStudyParagraphLines;
    execution: {
      lead: string;
      steps: { title: string; body: string }[];
    };
    results: CaseStudyParagraphLines;
    lesson: CaseStudyParagraphLines;
    whyThisMatters: CaseStudyParagraphLines;
  };
  footnote: string;
  /** Short snippets used throughout the rest of the report. */
  snippets: {
    /** ~1-line snippet for the Why-Steve / RCG section. */
    whySteveBio: string;
    /** ~1-2 line snippet for the Customer Experience callout. */
    customerExperience: string;
    /** Snippet for the Five-Step Framework "Case study" callout (step 4). */
    frameworkStep4: string;
    /** Snippet for the Five-Step Framework "Team model" callout (step 5). */
    frameworkStep5: string;
    /** Snippet referenced in narrative.ts plan body (step 5). */
    narrativeStep5: string;
    /** assemble.ts why_rcg.bio snippet. */
    whyRcgBio: string;
    /** assemble.ts case-study card summary. */
    cardSummary: string;
    /** assemble.ts case-study card metric. */
    cardMetric: string;
    /** Trailing reference link copy used at end of every snippet on the web. */
    referenceLinkLabel: string;
    /** Trailing reference label used in PDF inline mentions. */
    pdfReferenceLabel: string;
  };
};

export const DIVERSIFIED_HOSPITALITY_CASE_STUDY: DiversifiedCaseStudy = {
  preface: "This is not theory. Steve has already done this from the brand-owner side.",
  headline:
    "How Diversified Hospitality doubled its Amazon profit at flat revenue by taking the channel back from resellers",
  sections: {
    situation: {
      paragraphs: [
        "Diversified Hospitality Solutions was a hospitality manufacturer selling hotel amenities, soaps, shampoos, conditioners, lotions, detergents, and related products through traditional wholesale and distributor channels.",
        "For years, Amazon was not treated as a core brand-owned channel. Instead, resellers bought product through wholesale relationships and sold it on Amazon themselves.",
        "On the surface, this created sales volume. But underneath, it created the same problems many manufacturers face today:",
      ],
      bullets: [
        "Multiple sellers competing on the same listings",
        "Inconsistent product images, descriptions, packaging, and pricing",
        "Fragmented customer experience",
        "Poor control over reviews and product presentation",
        "Resellers capturing the margin created by the brand",
        "Delayed cash flow, because Diversified waited 60–90 days for reseller payments while resellers received faster Amazon payouts",
      ],
      tail: [
        "The clearest signal was financial: one major reseller generated more than $1.2 million in net income from Diversified's products in a single year, nearly matching Diversified's own total net income.",
        "Amazon had already become a meaningful channel.",
        "Diversified just did not fully own it yet.",
      ],
    },
    decision: {
      paragraphs: [
        "Diversified realized something simple:",
        "No one cares about the brand, the customer experience, the listings, the packaging, the reviews, or the long-term channel strategy as much as the brand owner.",
        "Resellers may sell product, but they usually do not build the brand.",
        "So Diversified made the decision to bring Amazon under brand control.",
        "The goal was not just to “remove resellers.”",
        "The goal was to:",
      ],
      bullets: [
        "Own the customer experience",
        "Standardize listings and packaging",
        "Control pricing and brand presentation",
        "Capture margin that was already flowing through Amazon",
        "Improve cash flow",
        "Build Amazon into a true brand-owned profit center",
      ],
    },
    execution: {
      lead: "Diversified followed a simple but disciplined transition process:",
      steps: [
        {
          title: "Took control of the Amazon catalog",
          body:
            "Diversified identified the products resellers were already selling, took control of key listings, standardized product content, and began treating Amazon as a strategic channel instead of an afterthought.",
        },
        {
          title: "Matched proven demand",
          body:
            "The company did not need to guess which products might work. Resellers had already shown where demand existed. Diversified focused on the SKUs, pack sizes, and configurations customers were already buying.",
        },
        {
          title: "Updated reseller and distributor policies",
          body:
            "Diversified stopped supplying resellers who were using the product to compete with the brand on Amazon and updated distribution agreements to prevent wholesale customers from feeding unauthorized Amazon sellers.",
        },
        {
          title: "Stocked and operated Amazon directly",
          body:
            "Diversified began supplying Amazon with its own inventory, managing listings, improving presentation, and creating a more consistent customer experience.",
        },
        {
          title: "Built the internal capability",
          body:
            "Instead of remaining dependent on resellers, Diversified built the internal systems, team, and operating rhythm needed to manage Amazon long term.",
        },
      ],
    },
    // Phase 59 — Case study is now strictly the Phase 1 / capture
    // story: flat revenue (~$2M before and after), doubled profit,
    // zero customer growth. All references to $8.34M / $9.02M / $10M
    // were removed per spec — Phase 2 growth belongs only in the
    // Phase 2 / CAO section, never in the case study.
    results: {
      paragraphs: [
        "Phase 1 — capture. Before Diversified took control, total Amazon sales of Diversified-branded products were running at roughly $2 million annually through reseller activity. Phase 1 was not about growing that revenue. It was about closing the leakage. Revenue stayed roughly flat at ~$2 million during the capture period — but the profit on those sales doubled, because the margin that resellers had been pocketing now flowed back to the brand. Diversified did not lose a single customer, and did not add one either; the entire profit lift came from removing the reseller layer. Diversified used the recovered margin to pay down more than $5 million in accounts payable across the capture period, and the channel was finally running under brand control.",
      ],
      bullets: [],
      tail: [
        "The key was not simply “removing resellers.” The key was that the brand owner finally had the ability and incentive to invest in the channel properly.",
        "The financial impact went beyond revenue:",
      ],
    },
    // Phase 59 — Lesson narrows to the Phase 1 / capture story. The
    // Phase 2 framing remains in the dedicated Phase 2 / CAO section
    // of the report.
    lesson: {
      paragraphs: [
        "Phase 1 — taking control of the channel and recovering the margin already in existing demand — closes the leak: profit doubles at flat revenue, cash flow improves, the brand stops subsidizing other people's businesses.",
        "If your products are already generating meaningful Amazon revenue through third-party sellers, the question is not whether Amazon works. The question is whether someone else should keep operating that channel, or whether your brand should own it. This audit is sized around answering that question for your brand.",
      ],
    },
    whyThisMatters: {
      // Phase 55 — section emptied; content merged into `lesson` above.
      // Renderer falls back to omitting the section when paragraphs is
      // empty.
      paragraphs: [],
    },
  },
  /** Results-section sub-bullets that follow the "financial impact went beyond revenue" line. */
  footnote:
    "This case reflects Steve Rolle's prior operational experience at Diversified Hospitality Solutions. Past results do not guarantee future outcomes; your channel and brand will have unique dynamics.",
  snippets: {
    whySteveBio:
      "Steve Rolle has lived this problem as a brand owner, not just as a consultant. At Diversified Hospitality, reseller-controlled Amazon activity created inconsistent listings, pricing issues, and margin leakage. Steve led the channel transition that doubled Diversified's Amazon profit on a flat ~$2M revenue base by removing the reseller layer and bringing the channel under brand control.",
    customerExperience:
      "At Diversified Hospitality, the biggest unlock was not only capturing reseller margin. The bigger unlock was that the brand owner finally controlled the customer experience, listings, packaging, inventory, pricing, reviews, and long-term channel strategy.",
    frameworkStep4:
      "When we did this for Diversified Hospitality, customer experience metrics improved immediately and Amazon profit on the existing ~$2M revenue base doubled — without adding a single new customer. The recovered margin paid down more than $5M in AP across the capture period.",
    frameworkStep5: "",
    narrativeStep5: "",
    whyRcgBio:
      "Steve Rolle ran Diversified Hospitality on Amazon as the operator before he ran it as a consultant. He led the channel transition that doubled the brand's Amazon profit on a flat ~$2M revenue base by removing resellers and taking direct channel control. Across the brands RCG operates today, we've sold over $60M on Amazon since 2018.",
    cardSummary:
      "Reclaimed the catalog from a long tail of unauthorized resellers and rebuilt brand-controlled distribution.",
    cardMetric: "Doubled Amazon profit at flat ~$2M revenue · zero customer loss",
    referenceLinkLabel: "Read the full case study",
    pdfReferenceLabel: "Full case study available on request",
  },
};

/**
 * Convenience accessor for the appendix anchor used in web links.
 * Matches the id assigned to the SectionCaseStudyDiversifiedHospitality
 * <section> element so in-page anchor scrolling works.
 */
export const DIVERSIFIED_CASE_STUDY_HREF = `#${CASE_STUDY_ANCHOR_ID}`;
