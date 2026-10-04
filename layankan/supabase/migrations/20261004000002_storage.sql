-- Private bucket for uploaded Business Brain source files (PDFs).
-- Accessed only server-side with the service role; no browser policies.
-- Guarded so the plain-Postgres RLS test harness (no storage schema) can run it.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('brain-sources', 'brain-sources', false, 10485760, array['application/pdf'])
    on conflict (id) do nothing;
  end if;
end $$;
