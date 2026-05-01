# Amazon Brand Reseller Audit

Cloned from `legion-opportunity-scanner` on 2026-04-30 as a clean duplicate environment for a new use case.

- **App**: Next.js 14 (App Router)
- **Database**: Supabase
- **Hosting**: Vercel
- **Email**: Microsoft Graph (Outlook drafts) via OAuth
- **External APIs**: Keepa, DataForSEO, OpenAI

This is currently a verbatim clone of the Legion scanner. Business logic will be repurposed in subsequent commits.

## Deploy URLs

- Production: TBD (Vercel)
- Repo: https://github.com/smr2724/brand-reseller-audit

## Setup

1. Copy `.env.local.example` → `.env.local` and fill in keys.
2. `npm install`
3. `npm run dev`
