-- =============================================================
-- Phase 3: Brand reviews + per-brand review counters
-- Idempotent. User-scoped. RLS enforced via auth.uid().
-- =============================================================
begin;

-- ---------- brand_reviews ----------
create table if not exists public.brand_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  decision text not null check (decision in ('qualified','disqualified','needs_research','skip')),
  disqualifier_reason text,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists brand_reviews_user_created_idx on public.brand_reviews (user_id, created_at desc);
create index if not exists brand_reviews_brand_idx on public.brand_reviews (brand_id, created_at desc);

alter table public.brand_reviews enable row level security;

drop policy if exists "brand_reviews_self_all" on public.brand_reviews;
create policy "brand_reviews_self_all" on public.brand_reviews
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- brands: review counters ----------
alter table public.brands add column if not exists last_reviewed_at timestamptz;
alter table public.brands add column if not exists review_count int not null default 0;

create index if not exists brands_user_last_reviewed_idx on public.brands (user_id, last_reviewed_at desc nulls last);

commit;
