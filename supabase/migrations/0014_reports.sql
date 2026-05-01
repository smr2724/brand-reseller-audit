-- =============================================================
-- 0014 — Channel Ownership Audit reports
-- Extends the Phase-1 reports table with brand-scoped audit columns,
-- adds report_templates, and prepares the 'reports' Storage bucket.
-- Idempotent: safe to re-run.
-- =============================================================

BEGIN;

-- ---------- reports: extend for brand-scoped Channel Ownership Audits ----------

-- Phase 1 created reports with NOT NULL supplier_id / opportunity_id.
-- For brand-scoped reports those don't apply, so relax the NOT NULL constraint.
alter table public.reports
  alter column supplier_id drop not null;
alter table public.reports
  alter column opportunity_id drop not null;

-- token was used for the public share link in Phase 1; brand audits don't
-- need a token, so allow NULL.
alter table public.reports
  alter column token drop not null;

alter table public.reports add column if not exists brand_id uuid references public.brands(id) on delete set null;
alter table public.reports add column if not exists title text;
alter table public.reports add column if not exists kind text not null default 'channel_ownership_audit';
alter table public.reports add column if not exists status text not null default 'generating';
alter table public.reports add column if not exists pdf_storage_path text;
alter table public.reports add column if not exists pdf_public_url text;
alter table public.reports add column if not exists narrative_json jsonb;
alter table public.reports add column if not exists error_message text;
alter table public.reports add column if not exists generated_at timestamptz;

create index if not exists reports_user_brand_idx on public.reports(user_id, brand_id, created_at desc);

-- ---------- report_templates ----------
create table if not exists public.report_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  kind text not null default 'channel_ownership_audit',
  brand_voice_sample text,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.report_templates enable row level security;

drop policy if exists report_templates_self_all on public.report_templates;
create policy report_templates_self_all on public.report_templates
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- Storage: reports bucket + per-user RLS on objects ----------
-- Best effort — wrapped so a permission/extension issue doesn't break the migration.
-- If this block fails, the bucket will be created on first upload from server code.
do $$
begin
  begin
    insert into storage.buckets (id, name, public)
    values ('reports', 'reports', false)
    on conflict (id) do nothing;
  exception when others then
    -- TODO: bucket creation is permission-gated in some envs. Fall back to runtime creation.
    raise notice 'storage.buckets insert skipped: %', sqlerrm;
  end;

  -- RLS policies on storage.objects scoped to the 'reports' bucket.
  begin
    drop policy if exists "reports_objects_select_own" on storage.objects;
    create policy "reports_objects_select_own" on storage.objects
      for select to authenticated
      using (
        bucket_id = 'reports'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  exception when others then
    raise notice 'reports_objects_select_own skipped: %', sqlerrm;
  end;

  begin
    drop policy if exists "reports_objects_insert_own" on storage.objects;
    create policy "reports_objects_insert_own" on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'reports'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  exception when others then
    raise notice 'reports_objects_insert_own skipped: %', sqlerrm;
  end;

  begin
    drop policy if exists "reports_objects_delete_own" on storage.objects;
    create policy "reports_objects_delete_own" on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'reports'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  exception when others then
    raise notice 'reports_objects_delete_own skipped: %', sqlerrm;
  end;
end $$;

COMMIT;
