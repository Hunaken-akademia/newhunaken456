create table if not exists public.yoso_cache (
  cache_key text primary key,
  cache_type text not null,
  race_date date,
  venue text,
  race_no smallint,
  payload jsonb not null,
  expires_at timestamptz not null,
  stale_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists yoso_cache_type_date_idx
on public.yoso_cache (cache_type, race_date, venue, race_no);

create index if not exists yoso_cache_expires_at_idx
on public.yoso_cache (expires_at);

alter table public.yoso_cache enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.yoso_cache to service_role;

-- 古いキャッシュ削除用。必要な時だけSQL Editorや定期処理から実行。
create or replace function public.delete_old_yoso_cache()
returns integer
language plpgsql
security definer
as $$
declare
  deleted_count integer;
begin
  delete from public.yoso_cache
  where stale_expires_at < now() - interval '1 hour';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

grant execute on function public.delete_old_yoso_cache() to service_role;

notify pgrst, 'reload schema';
