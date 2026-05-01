// Regex-based tagger for a brand's manual notes + dominant seller country.
// Returns a deduped, sorted array of disqualifier tag strings.

const PATTERNS: Array<{ tag: string; re: RegExp }> = [
  { tag: "chinese_drop_shipper", re: /chinese?\s+drop/i },
  { tag: "foreign_hq", re: /\bforeign\s+hq\b|\boverseas\s+hq\b|\bhq\s+(?:in|abroad)\b/i },
  { tag: "amazon_owned", re: /amazon[- ]?owned/i },
  { tag: "amazon_1p_vendor", re: /\b1P\b|vendor\s+central/i },
  { tag: "too_generic", re: /too\s+generic/i },
  { tag: "too_large", re: /too\s+large|enterprise/i },
  { tag: "no_contact_path", re: /no\s+(contact|website)/i },
  { tag: "bad_website", re: /bad\s+website|website\s+broken/i },
];

export function tagDisqualifiers(args: {
  notes?: string | null;
  dominant_seller_country?: string | null;
}): string[] {
  const notes = args.notes ?? "";
  const country = (args.dominant_seller_country ?? "").trim().toUpperCase();
  const tags = new Set<string>();

  if (country === "CN") tags.add("chinese_drop_shipper");

  if (notes) {
    for (const p of PATTERNS) {
      if (p.re.test(notes)) tags.add(p.tag);
    }
  }

  return Array.from(tags).sort();
}
