/**
 * Outreach email sequence — 5 templated steps.
 *
 * Steve's exact wording, with simple {{first_name}} and {{product_category}}
 * placeholders. Step 5 is the only one that uses {{report_url}} (sent after
 * the recipient confirms they want the report).
 *
 * NO AI generation. NO internal scoring metrics in the body.
 */

export type OutreachStep = 1 | 2 | 3 | 4 | 5;

export interface TemplateVars {
  first_name: string;
  product_category: string;
  report_url?: string;
}

export interface OutreachTemplate {
  step: OutreachStep;
  key: string;
  label: string;
  description: string;
  subject: string;
  body: string;
}

export const OUTREACH_TEMPLATES: Record<OutreachStep, OutreachTemplate> = {
  1: {
    step: 1,
    key: "initial",
    label: "Initial — Specific opportunity",
    description: "Cold open with a specific category and ask if they're the right person.",
    subject: "Amazon opportunity for {{product_category}}",
    body: `Hi {{first_name}},

I'm Steve Rolle, founder of Rolle Management Group.

My team has been researching niche Amazon categories where customers are already searching, but the current marketplace execution is weak. Your company came up as a potential fit for a specific opportunity we found around {{product_category}}.

This is the type of opportunity we specialize in. I helped build Diversified Hospitality's Amazon/e-commerce channel from zero in 2017 to approximately $10M/year within six years, and more recently our team helped Legion Chemicals go from $0 in Amazon sales in June 2025 to about $85,000 in April 2026.

We put together a short opportunity brief here that I'd love to send over to you next. Just let me know if you're the right person to send the opportunity report to and I'll send it over.

Steve`,
  },

  2: {
    step: 2,
    key: "follow_up_1",
    label: "Follow-up 1",
    description: "Reinforce that this is specific, not a generic pitch.",
    subject: "Re: Amazon opportunity for {{product_category}}",
    body: `Hi {{first_name}},

Wanted to follow up because this is not a generic Amazon services pitch.

We found a specific category gap connected to {{product_category}}, and your company stood out as a possible manufacturer/supplier that could actually win it.

The basic idea is simple: you already have the product capability, and we would bring the e-commerce engine.

Depending on what fits your business, this could be structured as done-for-you marketplace management, a wholesale/private-label relationship, or an authorized reseller model.

Worth a short conversation?

Steve`,
  },

  3: {
    step: 3,
    key: "follow_up_2",
    label: "Follow-up 2 — Right person?",
    description: "Re-route if the recipient isn't the right contact.",
    subject: "Should I send this to someone else?",
    body: `Hi {{first_name}},

Not sure if you're the right person for this, but I wanted to make sure it did not get lost.

We identified what looks like a real Amazon opportunity around {{product_category}}. The reason I reached out is because your company appears to already have the product capability, while the Amazon category itself looks underdeveloped.

If this is better handled by someone in sales, marketing, e-commerce, or leadership, would you mind pointing me in the right direction?

Steve`,
  },

  4: {
    step: 4,
    key: "breakup",
    label: "Breakup",
    description: "Polite close — leaves the door open.",
    subject: "Closing the loop",
    body: `Hi {{first_name}},

I'll close the loop here.

We found a specific Amazon opportunity around {{product_category}} and thought your company could be a strong fit based on your product capabilities.

If Amazon/e-commerce is not a priority right now, no worries.

But if you ever want to explore turning existing products into incremental marketplace revenue without building an internal Amazon team, I'd be happy to show you what we found.

Steve`,
  },

  5: {
    step: 5,
    key: "report_ready",
    label: "Report ready",
    description: "Send the public report link after they confirm they want it.",
    subject: "The {{product_category}} opportunity report",
    body: `Hi {{first_name}},

As promised — here's the short opportunity brief we put together for {{product_category}}:

{{report_url}}

It walks through what we're seeing in the category, why your company stood out as a fit, and how a partnership could be structured. No login required.

Take a look when you have a few minutes. Happy to dig in further if anything resonates.

Steve`,
  },
};

const ALL_TOKENS = ["{{first_name}}", "{{product_category}}", "{{report_url}}"];

export function fillTemplate(template: OutreachTemplate, vars: TemplateVars): { subject: string; body: string } {
  const fill = (s: string) =>
    s
      .replaceAll("{{first_name}}", vars.first_name || "there")
      .replaceAll("{{product_category}}", vars.product_category || "your product category")
      .replaceAll("{{report_url}}", vars.report_url ?? "[report link goes here]");

  return {
    subject: fill(template.subject),
    body: fill(template.body),
  };
}

export function getTemplate(step: OutreachStep): OutreachTemplate {
  return OUTREACH_TEMPLATES[step];
}

export function listTemplates(): OutreachTemplate[] {
  return [1, 2, 3, 4, 5].map((s) => OUTREACH_TEMPLATES[s as OutreachStep]);
}

/** True if the template body still contains an unfilled placeholder. */
export function hasUnfilledTokens(text: string): boolean {
  return ALL_TOKENS.some((t) => text.includes(t));
}
