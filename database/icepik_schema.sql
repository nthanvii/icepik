-- =====================================================================
-- ICEPik: MVP database schema for Supabase
--
-- How to run: Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Run it once on a fresh project. A project that already runs an earlier
-- version keeps its data with the files in database/migrations instead
-- (20261116_recovery_keys.sql, then 20261125_push_subscriptions.sql); never
-- use the "Starting over" lines at the bottom on real data.
--
-- Dashboard settings this schema expects (Authentication section):
--   1. Sign In / Providers -> "Allow anonymous sign-ins": ON
--      Once a visitor accepts the terms and privacy policy, the app calls
--      supabase.auth.signInAnonymously(), so people can post and verify right
--      away without giving any personal info.
--   2. Sign In / Providers -> Email -> "Confirm email": OFF
--      Lets an anonymous user save their account with a username + password
--      (no real email inbox needed). See "Saving an account" below.
--   3. Attack Protection -> CAPTCHA: ON (required), provider Turnstile
--      It guards account creation, password sign-in and Supabase's own
--      password-reset endpoint. Without it, one person can create many
--      throwaway accounts to fake confirmations or get around the posting
--      limit, and anyone can check whether a username has an account
--      (that endpoint answers differently for a username that exists).
--      Saving an account ("That username is taken") has no CAPTCHA; only
--      Supabase's per-IP rate limits (Authentication -> Rate Limits) slow
--      checks made that way. Put the Turnstile site key in the app's build
--      before turning CAPTCHA on, or every sign-in fails.
--   4. Audit Logs -> "Write audit logs to the database": OFF
--      Otherwise every sign-in's IP address is copied into auth.audit_log_entries.
--      Supabase Auth still keeps each session's latest IP address and browser
--      in auth.sessions; that can't be turned off (see the handoff doc's gaps).
--   5. Hooks -> Send Email -> Postgres -> public.block_auth_emails (defined below)
--      Supabase then never creates an emailed reset or sign-in code for an
--      account, so there is no hidden code to guess for a known username.
--   6. Sign In / Providers -> Email -> "Minimum password length": 15
--      NIST's rule for accounts where the password is the only factor.
--   7. Sign In / Providers -> Email -> "Require current password when
--      changing password": ON. Someone holding an unlocked phone then can't
--      change the password without knowing it.
--   Keep "Secure password change" OFF: it emails a code to the account's
--   address, which for ICEPik can never arrive, and saving accounts would break.
--
-- Saving an account (optional for users):
--   Supabase signs people in by email, so the app turns a username into a
--   login ID ending in the reserved domain ".invalid", which can never receive
--   mail. That way nobody can be emailed a password reset for someone else.
--   Usernames are 3 to 20 lowercase letters, numbers or underscores, and a
--   saved username can't be changed (the check_login_id trigger enforces both).
--     loginId: `${username.trim().toLowerCase()}@icepik.invalid`
--     save:    supabase.auth.updateUser({ email: loginId, password })
--     then:    supabase.auth.signInWithPassword({ email: loginId, password, options: { captchaToken } })
--              and supabase.rpc('create_recovery_key')
--     log in on another device: the same signInWithPassword call
--   The user keeps the same id, so their posts and votes carry over.
--   Passwords are stored (hashed) by Supabase Auth, never in these tables.
--   A forgotten password is reset with the recovery key shown when the
--   account was saved (see "Forgot password" below). Without the key, a
--   forgotten password means a new account.
--
-- Tables
--   profiles            one row per app user, no personal info
--   sightings           public ICE sighting pins shown on the map
--   sighting_votes      confirm / dispute votes that drive the verification factor
--   sighting_reporters  private link between a sighting and the user who posted it
--   recovery_keys       a hash of each saved account's recovery key
--   push_subscriptions  push endpoints for alerts, by coarse square only
--
-- Privacy model (PRD Part 5):
--   * Nothing anyone else can read links a person to a place. Active
--     sightings are public (expired ones can't be read through the app's
--     API); who posted or voted on one is visible only to that same user.
--   * Those private links are deleted within an hour after a sighting
--     expires, so even someone with full database access (a breach, a legal
--     demand) can't rebuild who reported what in the past.
--   * Pin locations are rounded to about 100 m. Voter locations are used for
--     the 1 km check and never stored. Saved places (home, work) never leave
--     the device: the app checks them against the pins it has loaded. For
--     push alerts the server gets only the ~2.2 km squares around them,
--     with no user id (push_subscriptions).
--   * Supabase's request logs record each request's IP address, full URL and
--     the user id from its session token, but not its body. So nothing that
--     identifies a pin goes in a URL: deleting a post and changing settings
--     go through rpc() calls, which send their arguments in the body.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------

create type public.sighting_category as enum ('patrol', 'vehicle', 'checkpoint', 'raid', 'other');

create type public.vote_type as enum ('confirm', 'dispute');


-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- One profile per Supabase auth user (anonymous or saved).
-- Deliberately holds no name, email, phone or location. The two totals
-- survive the hourly cleanup so you can still measure repeat contributors.
create table public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  preferred_language text not null default 'en'
                       check (char_length(preferred_language) between 2 and 10),
  sightings_posted   integer not null default 0,
  votes_cast         integer not null default 0,
  -- Posting limit: the clock hour of the user's latest post and how many
  -- posts they made in it. Cleared by the hourly cleanup.
  post_limit_hour    timestamptz,
  post_limit_count   smallint not null default 0,
  created_at         timestamptz not null default now()
);

-- A reported ICE sighting. Everything here is safe to show publicly.
-- category + agent_count + vehicle_count are the at-a-glance summary;
-- description is optional extra detail.
-- Sightings expire after 4 hours. Each person's first vote on a sighting, if
-- it's a confirmation, keeps it on the map for at least 2 more hours.
create table public.sightings (
  id                  uuid primary key default gen_random_uuid(),
  lat                 double precision not null check (lat between -90 and 90),   -- rounded to ~100 m on save
  lng                 double precision not null check (lng between -180 and 180),
  location_label      text check (char_length(location_label) <= 120),  -- e.g. 'Broad St & Girard Ave', no house number
  category            public.sighting_category not null default 'other',
  agent_count         smallint check (agent_count between 0 and 99),     -- null = not sure
  vehicle_count       smallint check (vehicle_count between 0 and 99),   -- null = not sure
  description         text check (char_length(description) <= 280),
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null default now() + interval '4 hours',

  -- Kept up to date by a trigger on sighting_votes; clients can't write these.
  -- They freeze when the sighting expires.
  confirm_count       integer not null default 0,
  dispute_count       integer not null default 0,

  -- Verification factor: 0.00 to 1.00, starts at 0.50 with no votes.
  verification_score  numeric(3, 2) generated always as (
                        round((confirm_count + 1)::numeric / (confirm_count + dispute_count + 2), 2)
                      ) stored,
  verification_status text generated always as (
                        case
                          when confirm_count >= 2 and confirm_count >= 2 * dispute_count then 'verified'
                          when dispute_count >= 2 and dispute_count > confirm_count then 'disputed'
                          else 'unverified'
                        end
                      ) stored
);

create index sightings_expires_at_idx on public.sightings (expires_at);

-- Who posted each sighting. Kept out of the sightings table so the public
-- map feed and Realtime stream never carry a user id. Only the reporter can
-- read their own rows; rows are written by a trigger, never by the app.
create table public.sighting_reporters (
  sighting_id uuid primary key references public.sightings (id) on delete cascade,
  reporter_id uuid not null references public.profiles (id) on delete cascade
);

create index sighting_reporters_reporter_idx on public.sighting_reporters (reporter_id);

-- One vote per user per sighting. Written only through vote_on_sighting(),
-- which checks the voter is nearby.
create table public.sighting_votes (
  sighting_id uuid not null references public.sightings (id) on delete cascade,
  voter_id    uuid not null references public.profiles (id) on delete cascade,
  vote        public.vote_type not null,
  created_at  timestamptz not null default now(),
  primary key (sighting_id, voter_id)
);

create index sighting_votes_voter_idx on public.sighting_votes (voter_id);


-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- Distance in meters between two points (haversine formula).
create function public.distance_m(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select 2 * 6371000 * asin(least(1.0, sqrt(
           power(sin(radians(lat2 - lat1) / 2), 2)
           + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
         )));
$$;


-- True when this session signed in with its password in the last 10 minutes
-- and still exists. Supabase writes how and when a session signed in into the
-- access token's amr claim, e.g. [{"method": "password", "timestamp": 1794614400}];
-- a refreshed token keeps the original sign-in time. The session check matters
-- because the database accepts an access token until it expires (1 hour by
-- default), even after a password reset or sign-out has ended its session.
-- Functions that someone holding an unlocked phone shouldn't run without the
-- password check this. Only security definer functions call it, so it reads
-- auth.sessions as their owner.
create function public.signed_in_with_password_recently()
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then
      exists (
        select 1 from jsonb_array_elements(auth.jwt() -> 'amr') m
        where m ->> 'method' = 'password'
          and (m ->> 'timestamp')::numeric > extract(epoch from now()) - 600)
      and exists (
        select 1 from auth.sessions s
        where s.user_id = auth.uid()
          and s.id::text = auth.jwt() ->> 'session_id')
    else false
  end;
$$;

revoke execute on function public.signed_in_with_password_recently() from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------

-- Create a profile whenever someone signs up (including anonymous sign-ins).
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Give any users that already exist a profile too.
insert into public.profiles (id)
select id from auth.users
on conflict (id) do nothing;

-- Saved accounts: the login ID must be username@icepik.invalid, with a
-- username of 3 to 20 lowercase letters, numbers or underscores (the rule the
-- password reset uses), and it can't change once saved. This keeps real email
-- addresses and phone numbers out of auth.users, and stops someone holding an
-- unlocked phone from renaming the account so its owner can't log in or reset
-- the password. Supabase reports a refusal here only as "Database error ..."
-- (code unexpected_failure), so the app checks the username before saving.
-- Supabase Auth's own soft delete overwrites the email and phone with hashes,
-- so that one update is let through.
-- If this trigger ever blocks Supabase Auth, run
--   drop function public.check_login_id() cascade;
-- (drop trigger is refused: Supabase's Auth role owns auth.users), then fix it
-- and run the migration again to put it back.
create function public.check_login_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (to_jsonb(new) ->> 'deleted_at') is not null
     and (to_jsonb(old) ->> 'deleted_at') is null then
    return new;
  end if;

  if tg_op = 'UPDATE' and nullif(old.email, '') is not null
     and new.email is distinct from old.email then
    raise exception 'A saved username can''t be changed.';
  end if;

  if (tg_op = 'INSERT' or new.email is distinct from old.email)
     and nullif(new.email, '') is not null
     and new.email !~ '^[a-z0-9_]{3,20}@icepik\.invalid$' then
    raise exception 'Usernames are 3 to 20 lowercase letters, numbers or underscores.';
  end if;

  if (tg_op = 'INSERT' or new.phone is distinct from old.phone)
     and nullif(new.phone, '') is not null then
    raise exception 'ICEPik accounts have no phone number.';
  end if;

  return new;
end;
$$;

create trigger before_auth_user_saved
  before insert or update of email, phone on auth.users
  for each row execute function public.check_login_id();

-- Before a new sighting is saved: round the location to about 100 m, then
-- rate-limit the reporter and set the server-controlled fields so the app
-- can't backdate, extend or pre-verify a sighting. Inserts from the SQL
-- editor (no signed-in user) skip the second part, so you can seed test pins.
create function public.prepare_new_sighting()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  posts_this_hour smallint;
begin
  -- 3 decimal places = about 111 m north-south, 85 m east-west in Philadelphia
  new.lat := round(new.lat::numeric, 3);
  new.lng := round(new.lng::numeric, 3);

  -- A full street address would undo the rounding, so drop a leading house
  -- number: '1234 N Broad St' -> 'N Broad St'. Labels like '5th St & Market St'
  -- and '1200 block of N Broad St' are left alone. The app should still
  -- build the label from the rounded point, using street names only.
  new.location_label := nullif(btrim(regexp_replace(
    new.location_label, '^\s*\d+(-\d+)?[a-z]?\s+(?!block\y)', '', 'i')), '');

  if auth.uid() is null then
    return new;
  end if;

  -- Posts are counted per clock hour on the profile, so deleting a post
  -- doesn't free up room for another one.
  update public.profiles p
  set post_limit_count = case when p.post_limit_hour = date_trunc('hour', now())
                              then p.post_limit_count + 1 else 1 end,
      post_limit_hour  = date_trunc('hour', now()),
      sightings_posted = p.sightings_posted + 1
  where p.id = auth.uid()
  returning p.post_limit_count into posts_this_hour;

  if posts_this_hour > 5 then
    raise exception 'You can post up to 5 sightings an hour. Try again later.';
  end if;

  new.created_at    := now();
  new.expires_at    := now() + interval '4 hours';
  new.confirm_count := 0;
  new.dispute_count := 0;
  return new;
end;
$$;

create trigger before_sighting_insert
  before insert on public.sightings
  for each row execute function public.prepare_new_sighting();

-- After a sighting is saved, privately record who posted it.
create function public.record_sighting_reporter()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if auth.uid() is not null then
    insert into public.sighting_reporters (sighting_id, reporter_id)
    values (new.id, auth.uid());
  end if;
  return null;
end;
$$;

create trigger after_sighting_insert
  after insert on public.sightings
  for each row execute function public.record_sighting_reporter();

-- Recount confirm/dispute totals whenever a vote is added, changed or removed.
-- Counts only change while the sighting is active, so the hourly cleanup
-- can delete old votes without erasing the final verification result.
-- Each person's first vote on a sighting, if it's a confirmation, also keeps
-- the sighting on the map for at least 2 more hours. Switching a vote later
-- (dispute to confirm or back) doesn't.
create function public.refresh_sighting_votes()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  target_id uuid;
begin
  for target_id in
    select distinct x
    from unnest(array[old.sighting_id, new.sighting_id]) as x
    where x is not null
  loop
    -- Lock the sighting first. When two people vote at the same moment,
    -- the second recount waits here and then counts both votes.
    perform 1 from public.sightings
    where id = target_id and expires_at > now()
    for update;

    update public.sightings s
    set confirm_count = (select count(*) from public.sighting_votes v
                         where v.sighting_id = target_id and v.vote = 'confirm'),
        dispute_count = (select count(*) from public.sighting_votes v
                         where v.sighting_id = target_id and v.vote = 'dispute')
    where s.id = target_id
      and s.expires_at > now();
  end loop;

  if tg_op = 'INSERT' then
    if new.vote = 'confirm' then
      update public.sightings s
      set expires_at = greatest(s.expires_at, now() + interval '2 hours')
      where s.id = new.sighting_id
        and s.expires_at > now();
    end if;

    update public.profiles
    set votes_cast = votes_cast + 1
    where id = new.voter_id;
  end if;

  return null;
end;
$$;

create trigger after_vote_change
  after insert or update or delete on public.sighting_votes
  for each row execute function public.refresh_sighting_votes();


-- ---------------------------------------------------------------------
-- Functions the app calls with supabase.rpc(...)
-- ---------------------------------------------------------------------

-- Active sightings within radius_m meters of a point, nearest first.
-- Use it only for a pin dropped on the map. Never pass home or work: the app
-- checks saved places against the pins it has loaded, on the device.
-- The point you pass in is used for the calculation and never stored.
--   supabase.rpc('sightings_near', { pin_lat: 39.9526, pin_lng: -75.1652, radius_m: 1600 })
create function public.sightings_near(
  pin_lat  double precision,
  pin_lng  double precision,
  radius_m double precision default 1609  -- 1 mile
)
returns table (
  id                  uuid,
  lat                 double precision,
  lng                 double precision,
  location_label      text,
  category            public.sighting_category,
  agent_count         smallint,
  vehicle_count       smallint,
  description         text,
  created_at          timestamptz,
  expires_at          timestamptz,
  confirm_count       integer,
  dispute_count       integer,
  verification_score  numeric,
  verification_status text,
  distance_m          double precision
)
language sql
stable
set search_path = ''
as $$
  select s.id, s.lat, s.lng, s.location_label, s.category, s.agent_count, s.vehicle_count,
         s.description, s.created_at, s.expires_at, s.confirm_count, s.dispute_count,
         s.verification_score, s.verification_status, d.distance_m
  from public.sightings s
  cross join lateral (
    select public.distance_m(pin_lat, pin_lng, s.lat, s.lng) as distance_m
  ) d
  where s.expires_at > now()
    and d.distance_m <= radius_m
  order by d.distance_m;
$$;

-- Confirm or dispute a sighting. Calling it again changes your vote.
-- The voter must be within 1 km of the pin (PRD: verified by "users near
-- the area"). Their location is checked and never stored.
-- Returns the updated sighting so the app can redraw the pin.
-- Called only by the voteOnSighting server action, never from the browser.
--   supabase.rpc('vote_on_sighting', { target_sighting_id, my_vote: 'confirm', my_lat, my_lng })
create function public.vote_on_sighting(
  target_sighting_id uuid,
  my_vote            public.vote_type,
  my_lat             double precision,
  my_lng             double precision
)
returns public.sightings
language plpgsql
security definer set search_path = ''
as $$
declare
  target public.sightings;
begin
  if auth.uid() is null then
    raise exception 'Sign in to confirm or dispute a sighting.';
  end if;

  if my_lat is null or my_lng is null then
    raise exception 'Turn on location to confirm or dispute a sighting.';
  end if;

  select * into target from public.sightings where id = target_sighting_id;

  if not found then
    raise exception 'This sighting no longer exists.';
  end if;

  if target.expires_at <= now() then
    raise exception 'This sighting has expired.';
  end if;

  if exists (
    select 1 from public.sighting_reporters r
    where r.sighting_id = target_sighting_id and r.reporter_id = auth.uid()
  ) then
    raise exception 'You can''t confirm or dispute your own sighting.';
  end if;

  if public.distance_m(my_lat, my_lng, target.lat, target.lng) > 1000 then
    raise exception 'You need to be within 1 km of a sighting to confirm or dispute it.';
  end if;

  insert into public.sighting_votes (sighting_id, voter_id, vote)
  values (target_sighting_id, auth.uid(), my_vote)
  on conflict (sighting_id, voter_id) do update set vote = excluded.vote;

  select * into target from public.sightings where id = target_sighting_id;
  return target;
end;
$$;

revoke execute on function public.vote_on_sighting(uuid, public.vote_type, double precision, double precision) from public, anon;
grant execute on function public.vote_on_sighting(uuid, public.vote_type, double precision, double precision) to authenticated;

-- Permanently delete the signed-in user's account (Settings page).
-- Removes their profile and every private link to sightings they posted or
-- voted on; the sightings themselves stay on the map.
-- Users must be able to delete their account themselves from Settings.
-- A saved account must have signed in with its password in the last 10
-- minutes, so someone holding an unlocked phone can't delete it. An anonymous
-- account has no password and can always delete itself.
--   saved accounts first: await supabase.auth.signInWithPassword({ email: loginId, password, options: { captchaToken } })
--   await supabase.rpc('delete_my_account'); await supabase.auth.signOut({ scope: 'local' })
create function public.delete_my_account()
returns void
language plpgsql
security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to delete your account.';
  end if;

  if exists (select 1 from auth.users u
             where u.id = auth.uid() and nullif(u.email, '') is not null)
     and not public.signed_in_with_password_recently() then
    raise exception 'Enter your password again to delete your account.';
  end if;

  delete from auth.users where id = auth.uid();
end;
$$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- Delete an active sighting you posted. The pin's id travels in the request
-- body, not in a URL that Supabase logs. Called by the deleteSighting server
-- action.
--   supabase.rpc('delete_my_sighting', { target_sighting_id })
create function public.delete_my_sighting(target_sighting_id uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to delete a sighting.';
  end if;

  delete from public.sightings s
  using public.sighting_reporters r
  where s.id = target_sighting_id
    and r.sighting_id = s.id
    and r.reporter_id = auth.uid()
    and s.expires_at > now();

  if not found then
    raise exception 'You can only delete active sightings you posted.';
  end if;
end;
$$;

revoke execute on function public.delete_my_sighting(uuid) from public, anon;
grant execute on function public.delete_my_sighting(uuid) to authenticated;

-- Change the signed-in user's language (Settings page), keeping their id
-- out of the logged URL.
--   supabase.rpc('set_my_language', { new_language: 'es' })
create function public.set_my_language(new_language text)
returns void
language sql
security definer set search_path = ''
as $$
  update public.profiles
  set preferred_language = new_language
  where id = auth.uid();
$$;

revoke execute on function public.set_my_language(text) from public, anon;
grant execute on function public.set_my_language(text) to authenticated;


-- ---------------------------------------------------------------------
-- Supabase Auth email hook: ICEPik never sends email
-- ---------------------------------------------------------------------

-- Login IDs end in .invalid, so no email can ever arrive. Supabase's own
-- "forgot password" and magic-link endpoints would still store a 6-digit code
-- for a known username if an email provider accepted the message, leaving a
-- code that nobody receives but someone could guess. Refusing every email
-- that carries a code stops Supabase from storing one. Notification-only
-- emails are dropped quietly so they can't block a password change.
-- Turn it on: Authentication -> Hooks -> Send Email -> Postgres -> block_auth_emails.
create function public.block_auth_emails(event jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case
    when event -> 'email_data' ->> 'email_action_type' like '%\_notification' then '{}'::jsonb
    else jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'ICEPik does not send email.'))
  end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.block_auth_emails(jsonb) to supabase_auth_admin;
revoke execute on function public.block_auth_emails(jsonb) from authenticated, anon, public;


-- ---------------------------------------------------------------------
-- Forgot password: recovery keys (no email, no phone)
-- ---------------------------------------------------------------------

-- When someone saves their account, the app shows them a one-time recovery
-- key; only a SHA-256 hash of it is stored. To reset a forgotten password
-- they enter their username, the key and a new password. The server action
-- resetPasswordWithRecoveryKey checks the pair, sets the new password with
-- the secret key and replaces the used key with a new one shown on the spot.
-- The reset ends every session on the account. A device that is already
-- signed in can still read and post until its access token expires (1 hour
-- by default), but it can no longer make a recovery key or delete the account:
-- those check that the token's session still exists.

create extension if not exists pgcrypto with schema extensions;

-- One recovery key per saved account. Nobody reads or writes this table
-- through the API; only the functions below touch it. Row level security
-- with no policies blocks every row, and the browser roles also lose their
-- table grants, so a policy added by mistake later still exposes nothing.
create table public.recovery_keys (
  user_id  uuid primary key references public.profiles (id) on delete cascade,
  key_hash bytea not null
);

alter table public.recovery_keys enable row level security;
revoke all on public.recovery_keys from anon, authenticated;

-- Server only (secret key): give an account a new recovery key and return it
-- once. Any older key stops working. 128 random bits, shown as 8 groups of 4
-- hex characters; at 128 bits a plain SHA-256 hash is enough to store it.
create function public.replace_recovery_key(p_user_id uuid)
returns text
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  raw_key text := encode(extensions.gen_random_bytes(16), 'hex');
begin
  insert into public.recovery_keys (user_id, key_hash)
  values (p_user_id, extensions.digest(raw_key, 'sha256'))
  on conflict (user_id) do update set key_hash = excluded.key_hash;

  return rtrim(regexp_replace(raw_key, '(.{4})', '\1-', 'g'), '-');
end;
$$;

-- The signed-in user's first key (right after saving the account), or a new
-- one from Settings when they think someone saw theirs. Works only within
-- 10 minutes of signing in with the password, so someone holding an unlocked
-- phone can't make a key (and then reset the password) without knowing it.
-- The app signs in with the password first, then calls it:
--   await supabase.auth.signInWithPassword({ email: loginId, password, options: { captchaToken } })
--   const { data: key } = await supabase.rpc('create_recovery_key')
create function public.create_recovery_key()
returns text
language plpgsql
volatile
security definer set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, true) then
    raise exception 'Save your account with a username and password first.';
  end if;

  if not public.signed_in_with_password_recently() then
    raise exception 'Enter your password again to make a recovery key.';
  end if;

  return public.replace_recovery_key(auth.uid());
end;
$$;

-- Whether the signed-in user has a recovery key. Ask a saved account with
-- none to make one (for example when saving was interrupted).
--   const { data: hasKey } = await supabase.rpc('has_recovery_key')
create function public.has_recovery_key()
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (select 1 from public.recovery_keys where user_id = auth.uid());
$$;

-- Server only (secret key): the account id when the username and recovery key
-- match, otherwise null. Unknown usernames and wrong keys look the same.
-- Dashes, spaces and letter case in the typed key don't matter.
create function public.check_recovery_key(p_username text, p_key text)
returns uuid
language sql
stable
security definer set search_path = ''
as $$
  select k.user_id
  from public.recovery_keys k
  join auth.users u on u.id = k.user_id
  where u.email = lower(btrim(p_username)) || '@icepik.invalid'
    and k.key_hash = extensions.digest(regexp_replace(lower(p_key), '[^0-9a-f]', '', 'g'), 'sha256');
$$;

revoke execute on function public.create_recovery_key() from public, anon;
grant execute on function public.create_recovery_key() to authenticated;
revoke execute on function public.has_recovery_key() from public, anon;
grant execute on function public.has_recovery_key() to authenticated;
revoke execute on function public.replace_recovery_key(uuid) from public, anon, authenticated;
revoke execute on function public.check_recovery_key(text, text) from public, anon, authenticated;
grant execute on function public.replace_recovery_key(uuid) to service_role;
grant execute on function public.check_recovery_key(text, text) to service_role;


-- ---------------------------------------------------------------------
-- Hourly cleanup: forget who posted and voted on expired sightings
-- ---------------------------------------------------------------------

-- Expired sightings keep their location, details and final counts (that's
-- what the accuracy metric uses); only the person-to-sighting links go,
-- along with posting-limit hours that have already ended.
create function public.purge_expired_links()
returns void
language sql
security definer set search_path = ''
as $$
  delete from public.sighting_votes v
  using public.sightings s
  where s.id = v.sighting_id and s.expires_at <= now();

  delete from public.sighting_reporters r
  using public.sightings s
  where s.id = r.sighting_id and s.expires_at <= now();

  update public.profiles
  set post_limit_hour = null, post_limit_count = 0
  where post_limit_hour < date_trunc('hour', now());
$$;

revoke execute on function public.purge_expired_links() from public, anon, authenticated;

-- Create pg_cron only when it's missing. Supabase gives the postgres role
-- access to it when it's created; asking again on a project where it's
-- already on makes Supabase redo those grants, which can fail with
-- "dependent privileges exist".
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    create extension pg_cron with schema pg_catalog;
  end if;
end $$;

select cron.schedule('purge-expired-links', '0 * * * *', 'select public.purge_expired_links()');


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
create function public.push_cell(p_lat double precision, p_lng double precision)
returns bigint
language sql immutable parallel safe
set search_path = ''
as $$
  select ((round(p_lat * 1000)::bigint + 90000) / 20) * 20000
       + ((round(p_lng * 1000)::bigint + 180000) / 26)
$$;

-- Only the push services of Chrome (FCM), Apple, Mozilla and Microsoft, so
-- the sender can never be aimed at any other URL.
create table public.push_subscriptions (
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
create index push_subscriptions_cells_idx on public.push_subscriptions using gin (cells);
alter table public.push_subscriptions enable row level security;   -- and no policies
revoke all on public.push_subscriptions from anon, authenticated;

-- The cells sorted, without repeats. Refuses ('push_invalid') a missing
-- value or one outside the grid (rows 0 to 9000, columns 0 to 13846).
create function public.push_clean_cells(p_cells bigint[])
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
create function public.push_create(p_endpoint text, p_p256dh text, p_auth text, p_cells bigint[], p_secret text)
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
create function public.push_update(
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
create function public.push_delete(p_id uuid, p_secret text)
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
create function public.push_targets(p_lat double precision, p_lng double precision, p_after uuid, p_limit int)
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
create function public.push_drop(p_ids uuid[])
returns void
language sql
volatile
security definer set search_path = ''
as $$
  delete from public.push_subscriptions where id = any(p_ids);
$$;

-- Daily cleanup: subscriptions not renewed for 30 days.
create function public.push_purge()
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

-- Every day at 04:17 UTC, after pg_cron is set up above.
select cron.schedule('purge-push-subscriptions', '17 4 * * *', 'select public.push_purge()');


-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

alter table public.profiles           enable row level security;
alter table public.sightings          enable row level security;
alter table public.sighting_reporters enable row level security;
alter table public.sighting_votes     enable row level security;

-- profiles: you can read your own. The language changes only through
-- set_my_language(), so there is no update policy.
create policy "Users can read their own profile"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = id);

revoke update on public.profiles from anon, authenticated;

-- sightings: anyone can read active ones; signed-in users can post.
-- Reporters delete their own through delete_my_sighting(), so there is no
-- delete policy. Nobody edits a sighting after posting it.
-- Expired sightings stay in the table for your metrics but can't be read
-- through the API, so old pins and descriptions don't pile up in public.
create policy "Anyone can read active sightings"
  on public.sightings for select to anon, authenticated
  using (expires_at > now());

create policy "Signed-in users can post sightings"
  on public.sightings for insert to authenticated
  with check ((select auth.uid()) is not null);

-- sighting_reporters: you can see which active sightings you posted.
-- No one else can, and only the trigger above writes here.
create policy "Users can see the sightings they posted"
  on public.sighting_reporters for select to authenticated
  using ((select auth.uid()) = reporter_id);

-- sighting_votes: you can see your own votes. Casting or changing a vote
-- goes through vote_on_sighting(); votes are removed only by the cleanup
-- or account deletion, so there is no insert, update or delete policy.
create policy "Users can see their own votes"
  on public.sighting_votes for select to authenticated
  using ((select auth.uid()) = voter_id);


-- ---------------------------------------------------------------------
-- Realtime: push new sightings and changing vote counts to every open map
-- Pins expire without sending an event, so the app should also remove any
-- pin whose expires_at has passed.
-- ---------------------------------------------------------------------

alter publication supabase_realtime add table public.sightings;


-- =====================================================================
-- Success metric queries (PRD Part 1). Run these separately in the SQL
-- editor when you want to check progress; they aren't part of the setup.
-- =====================================================================

-- Users who have posted or voted more than once in total (goal: 20+)
-- select count(*) as repeat_contributors
-- from public.profiles
-- where sightings_posted + votes_cast > 1;

-- Accuracy rate: share of community-decided sightings that were confirmed (goal: 80%+)
-- select round(100.0 * count(*) filter (where verification_status = 'verified')
--              / nullif(count(*) filter (where verification_status <> 'unverified'), 0), 1)
--        as accuracy_pct
-- from public.sightings;


-- =====================================================================
-- Starting over (test projects only): to wipe ICEPik and run this script
-- again, copy the three commented lines below into a new query, remove the
-- "-- " at the start of each, and run them. They delete every ICEPik table
-- and all its data: pins, votes and profile totals (accounts in
-- Authentication -> Users are kept). To upgrade a project with data, use
-- database/migrations/20261116_recovery_keys.sql instead.
-- =====================================================================

-- drop table if exists public.push_subscriptions, public.recovery_keys, public.sighting_votes, public.sighting_reporters, public.sightings, public.profiles cascade;
-- drop function if exists public.handle_new_user, public.prepare_new_sighting, public.record_sighting_reporter, public.refresh_sighting_votes, public.sightings_near, public.distance_m, public.vote_on_sighting, public.delete_my_account, public.delete_my_sighting, public.set_my_language, public.block_auth_emails, public.signed_in_with_password_recently, public.create_recovery_key, public.has_recovery_key, public.replace_recovery_key, public.check_recovery_key, public.check_login_id, public.purge_expired_links, public.can_vote_on, public.push_cell, public.push_clean_cells, public.push_create, public.push_update, public.push_delete, public.push_targets, public.push_drop, public.push_purge cascade;
-- drop type if exists public.sighting_category, public.vote_type cascade;
