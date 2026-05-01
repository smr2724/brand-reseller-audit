# Amazon Channel Ownership Scanner

Internal tool for [Rolle Consulting Group](https://rolleconsulting.com) — finds brands whose Amazon channel is being run by third-party resellers, estimates lost revenue, and produces channel-ownership audit reports for prospective clients.

## Stack

- Next.js 14 (App Router) + TypeScript
- Supabase (auth, Postgres, RLS, Storage)
- Tailwind CSS
- Keepa, DataForSEO, Apollo.io, OpenAI
- Microsoft Graph (Outlook drafts)
- Hosted on Vercel

## Local dev

```bash
pnpm install   # or npm install
cp .env.example .env.local   # populate from Vercel env vars
pnpm dev
```

## Deploy

Auto-deploys on push to `main` via Vercel.

## Architecture

- `src/app/app/*` — authenticated app pages
- `src/app/api/*` — API route handlers
- `src/lib/*` — service clients (keepa, apollo, etc.) + business logic
- `supabase/migrations/*` — DB schema; apply via Supabase CLI or dashboard

## Phase 9 — Public audit request + brand lookup

This phase added two flows:

1. **Internal — Add Brand by Name** (`/app/brands/new`): single-input search,
   Keepa-verified candidate preview, one-click create + run full enrichment.
2. **Public — `/audit-request`**: prospect form with Cloudflare Turnstile,
   work-email gating, email verification, and a Vercel cron worker that
   runs Keepa + DataForSEO, generates the v2 audit, emails the prospect via
   Resend, and creates an Outlook follow-up draft for Steve.

### Required environment variables (set in Vercel)

| Var | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Transactional email (verification + report-ready + brand-not-found). |
| `RESEND_FROM_EMAIL` | From-address override. Defaults to `Rolle Consulting Group Audits <audits@rolleconsultinggroup.com>`. |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Cloudflare Turnstile public site key (rendered in the form). |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret used for server-side `siteverify`. |
| `DAILY_ENRICHMENT_BUDGET` | Hard cap on `enrichment_runs` per UTC day. Default `100`. The cron handler pauses (does not error) once the cap is hit. |
| `CRON_SECRET` | Required header for `/api/cron/process-audit-queue`. Send as `Authorization: Bearer <secret>` or `x-vercel-cron-signature: <secret>`. |
| `RCG_OWNER_USER_ID` | Optional. Supabase `auth.users.id` that owns brands created from public audit requests. Defaults to Steve's user_id. |
| `SLACK_WEBHOOK_URL` | Optional. If set, the cron handler posts a message on hard failures. |

### Resend / DNS setup

1. Add a `resend.rolleconsultinggroup.com` (or root) domain in the Resend dashboard.
2. Publish the `MX`, `SPF` (`TXT v=spf1 include:_spf.resend.com -all`), and DKIM
   `CNAME` records Resend gives you.
3. Verify the domain in Resend, then create an API key and store it as
   `RESEND_API_KEY` in Vercel.
4. Confirm `audits@rolleconsultinggroup.com` is allowed as a sender for that domain.

### Cron

`vercel.json` registers `/api/cron/process-audit-queue` to run every minute.
The route processes up to 5 verified leads per tick. Each lead goes through
`pending → matching → (not_found | enriching → generating_report → report_ready → sent)`.

Manual trigger:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://brand-reseller-audit.vercel.app/api/cron/process-audit-queue
```

### Migration

Apply `supabase/migrations/0020_phase9_audit_request.sql` to project
`qbgchatkwaqpbvxsramw` via the Supabase SQL editor or CLI before the first
deploy that includes Phase 9 code.
