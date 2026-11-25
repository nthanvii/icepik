-- =====================================================================
-- ICEPik migration, November 2026: push alerts (server side).
--
-- For the REAL Supabase project only, after
-- database/migrations/20261116_recovery_keys.sql. Never run it on the demo
-- project: /demo has no push alerts. A fresh project doesn't need it:
-- database/icepik_schema.sql already includes all of this.
--
-- It adds the push_subscriptions table (push endpoints by coarse ~2.2 km
-- square, with no user id and no time of day), its functions, which only
-- the secret key can call, and a daily cleanup job. Nothing else changes.
-- It runs as one transaction (if any statement fails, nothing changes) and
-- is safe to run more than once.
--
-- Run it in the SQL Editor (see "Owner steps for push" in
-- docs/database-handoff.md). The last statement should show 129944032, the
-- same square lib/push-cells.ts gives for (39.952, -75.164).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Push alerts: subscriptions by coarse square, never by person or place
-- ---------------------------------------------------------------------

-- A phone that wants alerts sends its push endpoint and keys, a random
-- device secret, and the squares ("cells") around the places it watches.
-- A cell is a fixed square 0.020° of latitude by 0.026° of longitude, about
-- 2.2 km x 2.2 km at 40°N. For each place the phone sends every square within
-- its alert distance of the square that holds the place. That list depends
-- only on which square the place is in, so this table can't place anyone
-- more precisely than one square. The phone checks the exact distance itself
-- and writes the alert text.
-- No row holds a user id or a time of day, and a row expires 30 days after
-- the app was last opened. Only the server (secret key) can call these
-- functions: app/actions/push.ts checks a Turnstile token before
-- push_create, and the device secret (kept here only as its SHA-256) guards
-- push_update and push_delete. The sender (a Supabase Edge Function) uses
-- push_targets and push_drop.

-- Square id for a point. Must match cellOf() in lib/push-cells.ts.
create or replace function public.push_cell(p_lat double precision, p_lng double precision)
returns bigint
language sql immutable parallel safe
set search_path = ''
as $$
  select ((round(p_lat * 1000)::bigint + 90000) / 20) * 20000
       + ((round(p_lng * 1000)::bigint + 180000) / 26)
$$;

-- Only the push services of Chrome (FCM), Apple, Mozilla and Microsoft, so
-- the sender can never be aimed at any other URL.
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  endpoint    text not null unique check (
                char_length(endpoint) <= 1024 and endpoint ~
                '^https://(fcm\.googleapis\.com|jmt17\.google\.com|web\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)/'),
  p256dh      text not null check (p256dh ~ '^[A-Za-z0-9_-]{87}$'),
  auth        text not null check (auth ~ '^[A-Za-z0-9_-]{22}$'),
  cells       bigint[] not null check (cardinality(cells) between 1 and 1000),
  secret_hash bytea not null check (octet_length(secret_hash) = 32),
  created_on  date not null default current_date,      -- a date: no time of day
  expires_on  date not null default current_date + 30   -- a date, for the same reason
);
create index if not exists push_subscriptions_cells_idx on public.push_subscriptions using gin (cells);
alter table public.push_subscriptions enable row level security;   -- and no policies
revoke all on public.push_subscriptions from anon, authenticated;

-- The cells sorted, without repeats. Refuses ('push_invalid') a missing
-- value or one outside the grid (rows 0 to 9000, columns 0 to 13846).
create or replace function public.push_clean_cells(p_cells bigint[])
returns bigint[]
language plpgsql immutable
set search_path = ''
as $$
begin
  if p_cells is null then
    return null;
  end if;
  if exists (select 1 from unnest(p_cells) as c
             where c is null or c < 0 or c > 180019999 or c % 20000 > 13846) then
    raise exception 'push_invalid';
  end if;
  return array(select distinct c from unnest(p_cells) as c order by c);
end;
$$;

-- A new subscription; returns its id. The secret is 32 random bytes in
-- base64url (43 characters); only its SHA-256 is kept. An endpoint that
-- another row already holds raises 'push_endpoint_taken'.
create or replace function public.push_create(p_endpoint text, p_p256dh text, p_auth text, p_cells bigint[], p_secret text)
returns uuid
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_secret is null or p_secret !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'push_invalid';
  end if;

  insert into public.push_subscriptions (endpoint, p256dh, auth, cells, secret_hash)
  values (p_endpoint, p_p256dh, p_auth, public.push_clean_cells(p_cells),
          pg_catalog.sha256(pg_catalog.convert_to(p_secret, 'UTF8')))
  on conflict (endpoint) do nothing
  returning id into v_id;

  if v_id is null then
    raise exception 'push_endpoint_taken';
  end if;
  return v_id;
end;
$$;

-- Renew a subscription for 30 more days, and optionally replace its cells
-- or swap its push endpoint (endpoint, p256dh and auth together, or none).
-- False when the id or the secret doesn't match; a new endpoint that another
-- row holds raises 'push_endpoint_taken'.
create or replace function public.push_update(
  p_id uuid,
  p_secret text,
  p_cells bigint[] default null,
  p_endpoint text default null,
  p_p256dh text default null,
  p_auth text default null)
returns boolean
language plpgsql
volatile
security definer set search_path = ''
as $$
begin
  if (p_endpoint is null) <> (p_p256dh is null) or (p_endpoint is null) <> (p_auth is null) then
    raise exception 'push_invalid';
  end if;

  update public.push_subscriptions s
  set cells      = coalesce(public.push_clean_cells(p_cells), s.cells),
      endpoint   = coalesce(p_endpoint, s.endpoint),
      p256dh     = coalesce(p_p256dh, s.p256dh),
      auth       = coalesce(p_auth, s.auth),
      expires_on = current_date + 30
  where s.id = p_id
    and s.secret_hash = pg_catalog.sha256(pg_catalog.convert_to(p_secret, 'UTF8'));
  return found;
exception
  when unique_violation then
    raise exception 'push_endpoint_taken';
end;
$$;

-- Delete a subscription. False when the id or the secret doesn't match.
create or replace function public.push_delete(p_id uuid, p_secret text)
returns boolean
language plpgsql
volatile
security definer set search_path = ''
as $$
begin
  delete from public.push_subscriptions s
  where s.id = p_id
    and s.secret_hash = pg_catalog.sha256(pg_catalog.convert_to(p_secret, 'UTF8'));
  return found;
end;
$$;

-- For the sender: the live subscriptions whose cells hold a sighting's
-- square, a page at a time (at most 500), in id order. Pass the last id of
-- one page as p_after to get the next.
create or replace function public.push_targets(p_lat double precision, p_lng double precision, p_after uuid, p_limit int)
returns table (id uuid, endpoint text, p256dh text, auth text)
language sql
stable
security definer set search_path = ''
as $$
  select s.id, s.endpoint, s.p256dh, s.auth
  from public.push_subscriptions s
  where s.cells @> array[public.push_cell(p_lat, p_lng)]
    and s.expires_on >= current_date
    and (p_after is null or s.id > p_after)
  order by s.id
  limit least(greatest(p_limit, 1), 500);
$$;

-- For the sender: forget subscriptions whose push service answered that
-- they are gone (404 or 410).
create or replace function public.push_drop(p_ids uuid[])
returns void
language sql
volatile
security definer set search_path = ''
as $$
  delete from public.push_subscriptions where id = any(p_ids);
$$;

-- Daily cleanup: subscriptions not renewed for 30 days.
create or replace function public.push_purge()
returns void
language sql
volatile
security definer set search_path = ''
as $$
  delete from public.push_subscriptions where expires_on < current_date;
$$;

-- Postgres grants EXECUTE to PUBLIC by default, so revoke first.
revoke execute on function public.push_cell(double precision, double precision) from public, anon, authenticated;
revoke execute on function public.push_clean_cells(bigint[]) from public, anon, authenticated;
revoke execute on function public.push_create(text, text, text, bigint[], text) from public, anon, authenticated;
revoke execute on function public.push_update(uuid, text, bigint[], text, text, text) from public, anon, authenticated;
revoke execute on function public.push_delete(uuid, text) from public, anon, authenticated;
revoke execute on function public.push_targets(double precision, double precision, uuid, int) from public, anon, authenticated;
revoke execute on function public.push_drop(uuid[]) from public, anon, authenticated;
revoke execute on function public.push_purge() from public, anon, authenticated;
grant execute on function public.push_create(text, text, text, bigint[], text) to service_role;
grant execute on function public.push_update(uuid, text, bigint[], text, text, text) to service_role;
grant execute on function public.push_delete(uuid, text) to service_role;
grant execute on function public.push_targets(double precision, double precision, uuid, int) to service_role;
grant execute on function public.push_drop(uuid[]) to service_role;

-- Create pg_cron only when it's missing (as in icepik_schema.sql: asking
-- again on a project where it's already on can fail with "dependent
-- privileges exist").
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    create extension pg_cron with schema pg_catalog;
  end if;
end $$;

-- Every day at 04:17 UTC. Scheduling the same name again replaces the job.
select cron.schedule('purge-push-subscriptions', '17 4 * * *', 'select public.push_purge()');

commit;

-- Should be 129944032, as cellOf(39.952, -75.164) in lib/push-cells.ts.
select public.push_cell(39.952, -75.164) as push_cell_check;
