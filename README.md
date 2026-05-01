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
