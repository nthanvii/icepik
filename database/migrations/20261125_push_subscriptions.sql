-- =====================================================================
-- ICEPik migration, November 2026: push alerts (server side).
--
-- For the REAL Supabase project only, after
-- database/migrations/20261116_recovery_keys.sql. Never run it on the demo
-- project: /demo has no push alerts. A fresh project doesn't need it:
-- database/icepik_schema.sql already includes all of this.
--
-- It adds the push_subscriptions table (push endpoints by coarse ~2.2 km
-- square, with no user id and no time of day), the push_vapid_tokens table
-- (one signed VAPID token per push service, shared by every run of the
-- sender), their functions, which only the secret key can call, and a daily
-- cleanup job. Nothing else changes.
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
-- more precisely than one square. Every push is shown, with its real
-- distance from the nearest watched place, because browsers require a
-- visible notification for each push; the phone still writes the alert text.
-- No row holds a user id or a time of day, and a row expires 30 days after
-- the app was last opened. Only the server (secret key) can call these
-- functions: app/actions/push.ts checks a Turnstile token before
-- push_create, and the device secret (kept here only as its SHA-256) guards
-- push_update and push_delete. The sender (a Supabase Edge Function) uses
-- push_targets and push_drop, and push_vapid_get and push_vapid_put for its
-- signed token (below).

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

-- One signed VAPID token per push service, shared by every run of the
-- sender. A function worker on Supabase's Free plan lives at most 150 s, so
-- a token kept only in a worker's memory would be signed again for nearly
-- every pin, and Apple asks senders not to refresh it more than once an
-- hour. So the sender reads the token for a push service's origin with
-- push_vapid_get, and only when none is usable signs a new one and stores it
-- with push_vapid_put. A row holds the whole Authorization value
-- ("vapid t=<token>, k=<public key>"), never the private key. Keeping the
-- token here is acceptable: it expires within 12 hours (the sender signs it
-- for 12, and push_vapid_put refuses an expiry more than 24 hours ahead),
-- and it is useless without push endpoints, which only the secret key can
-- read. The origin is on the same allowlist as push_subscriptions.endpoint,
-- with no path and no port.
create table if not exists public.push_vapid_tokens (
  origin      text primary key check (origin ~
                '^https://(fcm\.googleapis\.com|jmt17\.google\.com|web\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)$'),
  public_key  text not null check (public_key ~ '^[A-Za-z0-9_-]{87}$'),
  subject     text not null check (char_length(subject) <= 512 and subject ~ '^(mailto:|https://)[^[:space:]<>]+$'),
  header      text not null check (char_length(header) <= 2048
                and header ~ '^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=[A-Za-z0-9_-]{87}$'
                and right(header, 87) = public_key),
  expires_at  timestamptz not null   -- the token's exp
);
alter table public.push_vapid_tokens enable row level security;   -- and no policies
revoke all on public.push_vapid_tokens from anon, authenticated;

-- For the sender: the stored Authorization value for a push service, or
-- null when no row has this origin, public key and subject with at least
-- 15 minutes left. Matching the key and subject means a rotated VAPID key
-- or a new subject never reuses an old token.
create or replace function public.push_vapid_get(p_origin text, p_public_key text, p_subject text)
returns text
language sql
stable
security definer set search_path = ''
as $$
  select t.header
  from public.push_vapid_tokens t
  where t.origin = p_origin
    and t.public_key = p_public_key
    and t.subject = p_subject
    and t.expires_at >= now() + interval '15 minutes';
$$;

-- For the sender: store a newly signed Authorization value for a push
-- service, replacing the one before it (the last writer wins). Refuses
-- ('push_invalid') an expiry that is missing, past, or more than 24 hours
-- ahead (RFC 8292's limit); the table's checks refuse a bad origin, key,
-- subject or header.
create or replace function public.push_vapid_put(p_origin text, p_public_key text, p_subject text, p_header text, p_expires_at timestamptz)
returns void
language plpgsql
volatile
security definer set search_path = ''
as $$
begin
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '24 hours' then
    raise exception 'push_invalid';
  end if;

  insert into public.push_vapid_tokens (origin, public_key, subject, header, expires_at)
  values (p_origin, p_public_key, p_subject, p_header, p_expires_at)
  on conflict (origin) do update
  set public_key = excluded.public_key,
      subject    = excluded.subject,
      header     = excluded.header,
      expires_at = excluded.expires_at;
end;
$$;

-- Daily cleanup: subscriptions not renewed for 30 days, and expired tokens.
create or replace function public.push_purge()
returns void
language sql
volatile
security definer set search_path = ''
as $$
  delete from public.push_subscriptions where expires_on < current_date;
  delete from public.push_vapid_tokens where expires_at < now();
$$;

-- Postgres grants EXECUTE to PUBLIC by default, so revoke first.
revoke execute on function public.push_cell(double precision, double precision) from public, anon, authenticated;
revoke execute on function public.push_clean_cells(bigint[]) from public, anon, authenticated;
revoke execute on function public.push_create(text, text, text, bigint[], text) from public, anon, authenticated;
revoke execute on function public.push_update(uuid, text, bigint[], text, text, text) from public, anon, authenticated;
revoke execute on function public.push_delete(uuid, text) from public, anon, authenticated;
revoke execute on function public.push_targets(double precision, double precision, uuid, int) from public, anon, authenticated;
revoke execute on function public.push_drop(uuid[]) from public, anon, authenticated;
revoke execute on function public.push_vapid_get(text, text, text) from public, anon, authenticated;
revoke execute on function public.push_vapid_put(text, text, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.push_purge() from public, anon, authenticated;
grant execute on function public.push_create(text, text, text, bigint[], text) to service_role;
grant execute on function public.push_update(uuid, text, bigint[], text, text, text) to service_role;
grant execute on function public.push_delete(uuid, text) to service_role;
grant execute on function public.push_targets(double precision, double precision, uuid, int) to service_role;
grant execute on function public.push_drop(uuid[]) to service_role;
grant execute on function public.push_vapid_get(text, text, text) to service_role;
grant execute on function public.push_vapid_put(text, text, text, text, timestamptz) to service_role;

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
