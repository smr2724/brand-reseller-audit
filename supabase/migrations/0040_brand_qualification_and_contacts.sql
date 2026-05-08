-- Migration 0040: Brand qualification + contact discovery layer (Phase 47)

-- 1. Qualification verdict per brand (1:1 with brands; replace-on-rerun model)
CREATE TABLE IF NOT EXISTS brand_qualifications (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id                    uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  -- Inputs snapshot (so we can reproduce the verdict)
  brand_name_input            text NOT NULL,
  top_seller_names            text[] NOT NULL DEFAULT '{}',
  asin_count                  int,
  ttm_revenue_estimate_usd    numeric(14,2),

  -- Disambiguation
  candidate_entities          jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- [{name, type, country, evidence_url, evidence_summary, confidence}]
  selected_entity             jsonb,
    -- {name, type, country, evidence_url, evidence_summary, confidence}
  selection_reasoning         text,

  -- Legal entity / ownership
  legal_entity_name           text,
  legal_entity_type           text  CHECK (legal_entity_type IN
                                ('individual','corporation','llc','subsidiary','partnership','unknown')),
  legal_entity_country        text,
  trademark_owner             text,
  trademark_attorney          text,
  trademark_serial            text,           -- USPTO serial number for source-of-truth
  trademark_status            text,           -- live/dead/pending
  ownership_signal            text  CHECK (ownership_signal IN
                                ('owner_operated','pe_owned','public','subsidiary','unknown')),

  -- ICP verdict
  icp_verdict                 text NOT NULL CHECK (icp_verdict IN
                                ('qualified','disqualified','needs_review')),
  icp_reasoning               text NOT NULL,
  disqualification_pattern    text  CHECK (disqualification_pattern IN
                                ('public_company','dealer_network','anti_amazon','enterprise',
                                 'subsidiary_of_giant','no_amazon_presence','other'))
                                  -- nullable when qualified
                                ,

  -- Hooks (ranked, cap 5)
  candidate_hooks             jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- [{ hook_code, hook_text, evidence, confidence }]
    -- hook_code is one of:
    --   anti_amazon_policy_violation
    --   trademark_split
    --   dominant_single_reseller
    --   geographic_diversion
    --   small_attorney_signal
    --   pe_or_holdco_dressed_as_indie
    --   custom

  -- Cost / observability
  llm_model                   text,
  llm_tokens_in               int,
  llm_tokens_out              int,
  llm_cost_usd                numeric(8,4),
  uspto_called                boolean NOT NULL DEFAULT false,
  opencorporates_called       boolean NOT NULL DEFAULT false,
  total_cost_usd              numeric(8,4),

  -- Override audit trail (warn-and-allow policy)
  manual_override             boolean NOT NULL DEFAULT false,
  manual_override_reason      text,
  manual_override_by          uuid,
  manual_override_at          timestamptz,

  state                       text NOT NULL DEFAULT 'pending'
                                CHECK (state IN ('pending','running','complete','error')),
  error_message               text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS brand_qualifications_brand_id_unique
  ON brand_qualifications(brand_id);
CREATE INDEX IF NOT EXISTS brand_qualifications_verdict_idx
  ON brand_qualifications(icp_verdict);

-- 2. Decision-maker contacts (1:N with brands)
CREATE TABLE IF NOT EXISTS brand_contacts (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id                    uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  qualification_id            uuid REFERENCES brand_qualifications(id) ON DELETE SET NULL,

  full_name                   text NOT NULL,
  first_name                  text,
  last_name                   text,
  title                       text,
  linkedin_url                text,
  company_name                text,
  company_domain              text,

  email                       text,
  email_source                text  CHECK (email_source IN
                                ('apollo','apollo_crm','hunter','hunter_pattern',
                                 'pattern_guess','manual','unknown')),
  email_pattern_used          text,        -- e.g. 'firstname@', 'first.last@', 'flast@'
  email_status                text  CHECK (email_status IN
                                ('verified','likely','risky','catch_all','guessed',
                                 'bounced','invalid','unknown')),
  email_verifier              text  CHECK (email_verifier IN
                                ('millionverifier','zerobounce','none')),
  email_verifier_score        numeric(4,3),
  email_verified_at           timestamptz,

  phone                       text,
  phone_status                text  CHECK (phone_status IN
                                ('verified','likely','unverified','unknown')),

  is_primary                  boolean NOT NULL DEFAULT false,
  ready_to_send               boolean NOT NULL DEFAULT false,

  apollo_person_id            text,
  apollo_organization_id      text,
  hunter_person_id            text,

  raw_apollo                  jsonb,         -- full payload for forensics
  raw_hunter                  jsonb,

  notes                       text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brand_contacts_brand_id_idx
  ON brand_contacts(brand_id);
CREATE UNIQUE INDEX IF NOT EXISTS brand_contacts_one_primary_per_brand
  ON brand_contacts(brand_id) WHERE is_primary = true;
CREATE INDEX IF NOT EXISTS brand_contacts_email_status_idx
  ON brand_contacts(email_status);

-- 3. Domain-level cache: pattern + verifier results, so we don't re-query the same domain
CREATE TABLE IF NOT EXISTS contact_domain_cache (
  domain                      text PRIMARY KEY,
  email_pattern               text,           -- 'firstname@', 'first.last@', etc, or 'unknown'
  pattern_source              text,           -- 'hunter','apollo','manual'
  pattern_confidence          numeric(4,3),
  is_catch_all                boolean,
  has_mx                      boolean,
  smtp_provider               text,           -- e.g. 'google','outlook','ionos'
  last_checked_at             timestamptz NOT NULL DEFAULT now(),
  created_at                  timestamptz NOT NULL DEFAULT now()
);

-- 4. Extend brands with the qualification gate state
ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS qualification_state  text NOT NULL DEFAULT 'pending'
    CHECK (qualification_state IN ('pending','running','complete','skipped','error')),
  ADD COLUMN IF NOT EXISTS qualification_id     uuid REFERENCES brand_qualifications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contacts_state       text NOT NULL DEFAULT 'pending'
    CHECK (contacts_state IN ('pending','running','complete','skipped','error'));
