-- Creates the captures table, storage bucket, and access policies that
-- booth-agent (src/supabase/supabaseClient.ts) depends on.
--
-- Neither existed in the target project before this migration - confirmed
-- live via information_schema/pg_policies introspection: the only table in
-- `public` was a leftover `test` table, and storage.objects had zero RLS
-- policies. toCaptureRecord()'s column list (id, event_id, source,
-- storage_path, print_size, taken_at) was previously a best guess written
-- without access to a real schema; this migration is that schema.
--
-- Access model:
--   - booth-agent runs locally on hardware Daniel controls, not in a
--     browser, and connects with the service_role key (see config change
--     in the same PR: supabase.serviceRoleKey, not supabase.anonKey).
--     service_role already bypasses RLS by default in every Supabase
--     project, so no grants/policies are created here for it - it can
--     insert/update `captures` and read/write storage.objects in the
--     `captures` bucket out of the box, with no explicit grant needed.
--   - anon (the guest-facing web app, running in guests' browsers) gets
--     READ-ONLY access: SELECT on `captures`, and a read-only storage
--     policy scoped to the `captures` bucket. It cannot insert, update, or
--     delete anything - only booth-agent writes captures. If the guest app
--     turns out to need more (e.g. a "favorite" or share action), that's a
--     separate table/policy to add once its actual requirements are known
--     - don't widen these policies speculatively.

create table if not exists public.captures (
  id uuid primary key,
  event_id text not null,
  source text not null check (source in ('canon', 'webcam')),
  storage_path text not null,
  print_size text check (print_size in ('4x6', '2x6-strip')),
  taken_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists captures_event_id_idx on public.captures (event_id);

alter table public.captures enable row level security;

create policy "anon can read captures"
  on public.captures
  for select
  to anon
  using (true);

-- Private bucket (not public: true) - anonymous reads still work via the
-- policy below, scoped to just this bucket, but nothing is hotlinkable
-- without going through a client that presents the anon key. If the guest
-- app needs plain <img src> URLs with no auth, switch `public` to true
-- here and the read policy becomes redundant (but harmless) for that case.
insert into storage.buckets (id, name, public)
values ('captures', 'captures', false)
on conflict (id) do nothing;

create policy "anon can read capture files"
  on storage.objects
  for select
  to anon
  using (bucket_id = 'captures');
