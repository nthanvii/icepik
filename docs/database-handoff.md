# ICEPik Database Handoff

Nov 19, 2026 · @Juan

## Overview

The ICEPik backend is ready for the MVP: a Supabase Postgres database with seven tables (two of them for push alerts), the database functions the app and its server actions call, and a live feed of map pins. Browsers read pins and manage their own account with supabase-js and the publishable key; posting, voting, deleting a pin and password resets go through Next.js server actions. The server enforces every rule, so the app can't break them by accident.

**The one rule everything follows:** nothing another user can read may connect a person to a place. Pins are public. Who posted or voted on a pin is private to that person, and those records are deleted within an hour after the pin expires. The section "What we need from you" lists how the app keeps this rule too.

- Handoff package: `icepik-handoff.zip` holds every file below, a PDF of this doc and a README.
- Schema: `icepik_schema.sql`, run once in Supabase's SQL Editor.
- Upgrade a project that already has data: `database/migrations/20261116_recovery_keys.sql`. It adds the recovery-key parts and replaces delete\_my\_account(), and keeps every pin, vote and account. Follow the order under "Existing project".
- Live checks for a scratch Supabase project: `scripts/supabase-live-checks.mjs`.
- Demo at `/demo`, in a separate Supabase project only: `database/icepik_demo_changes.sql`, run after the schema (see "Demo project" under "Before you start").
- Server code: `lib/supabase/server.ts`, `lib/supabase/admin.ts`, `app/actions/sightings.ts` and `app/actions/recovery.ts`, also printed under "How to call it".
- Diagram, access rules and copyable SQL: [ICEPik Database Map](https://claude.ai/artifact/8dMTG4gPJUmLJvZ2vKpZaS), or `icepik-database-map.html` in the package.
- **Frontend:** The setup code assumes Next.js on Vercel.

## Before you start

Confirm these nine Supabase settings with the backend owner, then set up the client. The browser uses only the project URL and the publishable key. The secret key (sb\_secret\_…) stays on the server for the password reset; the older service\_role key isn't used.

| Setting (Authentication section) | Value | Why |
| --- | --- | --- |
| Sign In / Providers → Allow anonymous sign-ins | On | The app creates an account silently once the user accepts the terms |
| Sign In / Providers → Email → Confirm email | Off | Lets users save a username and password without an inbox |
| Attack Protection → CAPTCHA | On (required) | Guards account creation, password sign-in and Supabase's own password reset against throwaway accounts and username checks. The app sends a `captchaToken` with every anonymous and password sign-in; it never calls Supabase's own password reset. Put the Turnstile site key in the app's build before turning CAPTCHA on, or every sign-in fails |
| Audit Logs → Write audit logs to the database | Off | Otherwise every sign-in's IP address is also copied into the database. Each session's latest IP still stays in auth.sessions (see the known gaps) |
| Hooks → Send Email → Postgres function block\_auth\_emails | On | Supabase never creates an emailed reset or sign-in code, so there is no hidden code to guess for a known username |
| Sign In / Providers → Email → Secure password change | Off | It emails a code to the account's address, which can never arrive; saving an account would fail once a session is a day old |
| Sign In / Providers → Email → Minimum password length | 15 | NIST's minimum when the password is an account's only protection |
| Sign In / Providers → Email → Password Requirements | No required characters | The app suggests a few random words; requiring capitals, digits or symbols refuses those (the live checks' step 2a fails), and NIST advises against such rules |
| Sign In / Providers → Email → Require current password when changing password | On | Someone holding an unlocked phone can't change the password without knowing it |

**Secret key.** The password reset needs Supabase's secret key (`sb_secret_…`; the older service\_role keys are being retired at the end of 2026). Add it in Vercel as `SUPABASE_SECRET_KEY` to the **Production** environment only, with **Sensitive** turned on: never to Preview or Development or a developer's .env.local (use a scratch project's keys to try the reset locally), and never with a `NEXT_PUBLIC_` name. Only `lib/supabase/admin.ts` reads it, for the password reset and push alerts (`app/actions/push.ts`); on a deployment without it, the reset answers that it isn't available and push alerts that they aren't. The key skips every database rule, so a leak would expose the private links between people and pins, and every account. If it leaks, make a new secret key in Supabase and delete the old one. The demo project's secret key, `DEMO_SUPABASE_SECRET_KEY`, follows the same rules (Production only, Sensitive, never `NEXT_PUBLIC_`); only the demo's reset uses it.

**Existing project.** ICEPik's own Supabase project had no real users, so it was started over instead: its ICEPik tables, functions and accounts were deleted and the whole schema was run fresh. A project that still runs the earlier schema and holds real data upgrades with `database/migrations/20261116_recovery_keys.sql`, never the whole schema or its "Starting over" lines, which delete every pin, vote and profile total. The file's header has the steps; do them in this order. (0) Run `scripts/supabase-live-checks.mjs` on a scratch project, and stop unless every check passes. (1) Make sure the Turnstile widget's hostname list includes the live domain, and deploy the app version that ships with the migration (ICEPik's Turnstile site key is built into `app/_components/captcha.tsx`; a production build stops if `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set to an empty value, which would turn the check off). Its "Delete my account" asks a saved account for its password, which the migration starts to require, and it works with the old database too. Open the site in a private window, accept the terms, and check that the Turnstile check completes and a new anonymous user appears. (2) Count the saved accounts whose login ID breaks the username rule, and delete or rename them: once the migration has run they can be deleted but no longer renamed. The app can't log them in or reset their password (one already signed in on a device can still delete itself). (3) Run the migration. (4) Turn on the settings above, CAPTCHA last. (5) Repeat the private-window check with CAPTCHA on.

**Demo project.** The demo at `/demo` is the same app on a second Supabase project, so its sample pins and votes never mix with the real map. That project runs this schema and then `database/icepik_demo_changes.sql`, which loosens two rules: anyone can confirm or dispute from anywhere (`vote_on_sighting()` keeps its location arguments but ignores them), and one confirmation that outnumbers the disputes marks a pin verified. Everything else stays the same, including every setting above, with CAPTCHA using the same Turnstile widget's secret key. The file stops unless the line near its top that confirms it's the demo project is uncommented: never run it on the real one. It adds four sample pins near City Hall, one verified, two unverified and one disputed, and the app opens `/demo` on them wherever the presenter is. Before presenting, run `select public.reset_demo();` in the demo project's SQL Editor: it puts the samples back and clears everyone else's pins and votes. It also runs every night. In the app, `lib/supabase/config.ts` holds both projects (`NEXT_PUBLIC_DEMO_SUPABASE_URL` and `NEXT_PUBLIC_DEMO_SUPABASE_PUBLISHABLE_KEY` for the demo), the server actions take a `demo` flag that only chooses the database, and the demo keeps its session in its own cookie (`sb-icepik-demo-auth-token`) and its saved places under their own names in the browser. "Clear this device" signs out of both projects and clears both. On `/demo`, "Forgot password?" is the demo's own reset, so a presenter can show it without a real key: any letters and numbers work as the recovery key, and the screen says so. The `resetPasswordWithRecoveryKey` action takes the same `demo` flag; only a literal `true` picks the demo (`pickDemo()` in `lib/supabase/config.ts`, shared with the sightings actions). The demo's reset finds the saved account by its username and uses a client built only from the demo project's URL and `DEMO_SUPABASE_SECRET_KEY` (`createDemoAdminClient()` in `lib/supabase/admin.ts`), which refuses to exist if that URL is the real project's, so it can't reach the real project. The real reset always checks the real key.

**Client.** Set up supabase-js with `@supabase/ssr`, the way Supabase's [Next.js guide](https://supabase.com/docs/guides/auth/server-side/nextjs) does: `createBrowserClient` in client components, and `createServerClient` with cookies in server code and middleware. The saved session *is* the anonymous account: if its cookie isn't kept, the user loses their account and their posts.

```ts
// lib/supabase/client.ts
import { createBrowserClient } from '@supabase/ssr'
import type { Database } from '@/database.types'

export const createClient = () =>
  createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  )
```

**Types.** Generate TypeScript types once the schema is in place, and again after any schema change.

```bash
npx supabase gen types typescript --project-id <project-ref> > database.types.ts
```

**Test pins.** Seed pins from the SQL Editor. They have no reporter, so anyone can vote on them, and they expire after 4 hours like real pins. Delete them before measuring the success metrics.

```sql
insert into public.sightings (lat, lng, category, agent_count, vehicle_count, location_label, description)
values (39.970, -75.160, 'vehicle', 2, 1, 'Broad St & Girard Ave', 'TEST'),
       (39.953, -75.165, 'checkpoint', 4, 2, 'Broad St & Market St', 'TEST');

-- when you're done testing
delete from public.sightings where description = 'TEST';
```

## Data model

The app works with four tables; a fifth, recovery\_keys, is reached only through database functions, and so are the two push alert tables (see "Push alerts"). Only `sightings` is public, and only while a pin is active; the other three return just the signed-in user's own rows.

![How the app reaches the database: 1 public table, 4 private](images/how-the-app-reaches-the-database.png)

Browsers read pins, receive live updates and manage their own account (language, recovery key, saving or deleting it). Posting, voting, deleting a pin and password resets run as server actions on Vercel, so those requests reach Supabase from Vercel's IP address instead of the user's. The private tables return only the signed-in user's own rows, and recovery\_keys returns nothing at all.

### sightings (public)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid | Primary key |
| `lat`, `lng` | number | Rounded to 3 decimals (about 100 m) when saved |
| `location_label` | text, up to 120 characters, optional | Street names only; a leading house number is removed |
| `category` | `patrol`, `vehicle`, `checkpoint`, `raid` or `other` | Defaults to `other` |
| `agent_count`, `vehicle_count` | whole number 0–99, optional | Empty means "not sure" |
| `description` | text, up to 280 characters, optional | Public and not moderated |
| `created_at` | timestamp | Set by the server |
| `expires_at` | timestamp | Posting time + 4 hours; a person's first vote, if it's a confirmation, extends it |
| `confirm_count`, `dispute_count` | whole number | Read only; kept current by the server |
| `verification_score` | number 0.00–1.00 | Read only; 0.50 before any votes |
| `verification_status` | `verified`, `disputed` or `unverified` | Read only |

The app reads active pins (signed in or not) and inserts new ones. It deletes its own active pins through `delete_my_sighting()`. Nobody can edit a pin after posting it.

### Private tables

| Table | Columns | What the app can do |
| --- | --- | --- |
| `sighting_votes` | `sighting_id`, `voter_id`, `vote` (`confirm` or `dispute`), `created_at` | Read your own votes. Cast or change a vote only through `vote_on_sighting()` |
| `sighting_reporters` | `sighting_id`, `reporter_id` | Read your own rows to list "my posts". The server writes them and deletes them after the pin expires |
| `profiles` | `id` (the user's id), `preferred_language`, `sightings_posted`, `votes_cast`, `post_limit_hour`, `post_limit_count`, `created_at` | Read your own profile. Change `preferred_language` only through `set_my_language()` |
| `recovery_keys` | `user_id`, `key_hash` (SHA-256 of the key) | Nothing: the browser roles have no grants on it and there are no row policies. Only the recovery-key functions read or write it |
| `push_subscriptions` | `id`, `endpoint`, `p256dh`, `auth`, `cells` (the ~2.2 km squares to alert for), `secret_hash` (SHA-256 of the device secret), `created_on`, `expires_on` (dates, no time of day) | Nothing: no grants for the browser roles and no row policies. Only the push functions, called with the secret key, read or write it. See "Push alerts" below |
| `push_vapid_tokens` | `origin` (a push service), `public_key`, `subject`, `header` (a signed VAPID `Authorization` value), `expires_at` | Nothing: no grants for the browser roles and no row policies. Only `push_vapid_get` and `push_vapid_put`, called with the secret key, read or write it. It never holds the private key. See "Push alerts" below |

### Server functions

| Call | Who | What it does |
| --- | --- | --- |
| `sightings_near(pin_lat, pin_lng, radius_m = 1609)` | Anyone | Active pins within `radius_m` meters, nearest first, each with `distance_m`. Only for a pin dropped on the map, never home or work |
| `vote_on_sighting(target_sighting_id, my_vote, my_lat, my_lng)` | Signed in | Called by the voteOnSighting server action. Confirms or disputes after checking the voter is within 1 km; returns the updated pin |
| `delete_my_sighting(target_sighting_id)` | Signed in | Called by the deleteSighting server action. Deletes your own active pin |
| `set_my_language(new_language)` | Signed in | Changes your language setting |
| `delete_my_account()` | Signed in | Deletes the account and its private records; its pins stay on the map. A saved account needs a password sign-in in the last 10 minutes, from a session that still exists |
| `create_recovery_key()` | Saved accounts, within 10 minutes of a password sign-in, from a session that still exists | Creates or replaces your recovery key and returns it once; any older key stops working |
| `has_recovery_key()` | Signed in | Whether you have a recovery key; ask a saved account without one to make one |
| `check_recovery_key(p_username, p_key)` | Server only (secret key) | The account id when the username and key match, otherwise nothing |
| `replace_recovery_key(p_user_id)` | Server only (secret key) | Gives the account a new key after a reset and returns it once |
| `push_create(p_endpoint, p_p256dh, p_auth, p_cells, p_secret)` | Server only (secret key) | Called by `createPushSubscription` after its Turnstile check. Saves a subscription and returns its id; `push_endpoint_taken` if the endpoint is already saved |
| `push_update(p_id, p_secret, p_cells?, p_endpoint?, p_p256dh?, p_auth?)` | Server only (secret key) | Called by `updatePushSubscription` and `POST /api/push/renew`. Renews for 30 days, and replaces the cells or swaps the endpoint and keys (all three together); false when the id or secret doesn't match |
| `push_delete(p_id, p_secret)` | Server only (secret key) | Called by `deletePushSubscription`. False when the id or secret doesn't match |
| `push_targets(p_lat, p_lng, p_after, p_limit)` | Server only (secret key) | For the sender (the `push-sightings` Edge Function): the live subscriptions whose cells hold a sighting's square, at most 500 per page, in id order |
| `push_drop(p_ids)` | Server only (secret key) | For the sender: deletes subscriptions whose push service says they're gone |
| `push_vapid_get(p_origin, p_public_key, p_subject)` | Server only (secret key) | For the sender: the stored `Authorization` value for a push service, or null unless it was signed with that public key and subject and has at least 15 minutes left |
| `push_vapid_put(p_origin, p_public_key, p_subject, p_header, p_expires_at)` | Server only (secret key) | For the sender: stores a newly signed `Authorization` value for a push service, replacing the one before (the last write wins); `push_invalid` for an expiry that is missing, past or more than 24 hours ahead |
| `push_cell(p_lat, p_lng)`, `push_purge()` | Nobody through the API | The square id for a point (same as `cellOf()` in `lib/push-cells.ts`), and the daily cleanup of old subscriptions and expired tokens |

## How to call it

Reads and live updates use supabase-js in the browser. Posting, voting and deleting a pin go through Next.js server actions, so Supabase logs Vercel's IP for them instead of the user's (it still logs the user id; see the known gaps). Errors come back as plain messages ready to show (see "Errors to handle").

### Server actions (copy these four files)

`lib/supabase/server.ts` is Supabase's official server client for Next.js. `lib/supabase/admin.ts` is the only client that holds the secret key, and only the password reset uses it. `app/actions/sightings.ts` holds posting, voting and deleting; `app/actions/recovery.ts` holds the password reset. All of them import the generated types from `database.types.ts` at the project root; change that path if yours differs. They pass a type-check against Next.js 16.4, `@supabase/ssr` 0.12 and `@supabase/supabase-js` 2.118, plus tests that call them with missing, wrong-type and oversized input. Run `npm install server-only` for the guard at the top of both `lib` files.

These copies are for one Supabase project. ICEPik's own files in this repository add the demo at `/demo` on top: each action takes a `demo` flag that only picks the demo project (`pickDemo()` in `lib/supabase/config.ts`), and `lib/supabase/admin.ts` also has `createDemoAdminClient()`, for the demo's own password reset (see "Demo project" above).

```ts
// lib/supabase/server.ts
import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/database.types'

/**
 * Supabase client for server code (server actions, route handlers).
 * Same as Supabase's official Next.js example, plus the generated types.
 *
 * Don't put this client in a global variable. Create a new one inside each
 * function that uses it.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // Called from a Server Component, which can't set cookies.
            // Safe to ignore while proxy.ts (middleware.ts before Next.js 16)
            // refreshes user sessions.
          }
        },
      },
    },
  )
}
```

```ts
// app/actions/sightings.ts
'use server'

// Posting, voting and deleting run here, on Vercel, instead of in the browser.
// Supabase then logs Vercel's IP address for these requests instead of the
// user's. Its logs still record the user id from the session token, so while
// it keeps them they can match these requests to the same user's browser
// requests, which do carry their IP. See the known gaps in the handoff doc.
//
// Rules for this file:
// - Anyone can call these actions directly with any input, not just through
//   our UI. TypeScript types aren't checked at runtime, so every argument is
//   checked here before it reaches the database.
// - Build each database row field by field. Never pass client input straight
//   into a query, or callers could set fields they shouldn't.
// - Never accept a user id from the caller. The database takes the user from
//   the session cookie.
// - Never console.log the input. Vercel keeps runtime logs, and the input holds
//   coordinates and pin ids.
// - Return errors as values. Next.js hides the message of a thrown error in
//   production, and the database's messages are already written for users.
//
// Usage from a client component:
//   const result = await voteOnSighting({ sightingId, vote: 'confirm', myLat, myLng })
//   if (!result.ok) showMessage(result.message)

import type { PostgrestError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import type { Database } from '@/database.types'

type Sighting = Database['public']['Tables']['sightings']['Row']
type Category = Database['public']['Enums']['sighting_category']
type Vote = Database['public']['Enums']['vote_type']

export type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string }

export type NewSighting = {
  lat: number
  lng: number
  category: Category
  agentCount?: number | null
  vehicleCount?: number | null
  locationLabel?: string | null
  description?: string | null
}

const CATEGORIES: readonly Category[] = ['patrol', 'vehicle', 'checkpoint', 'raid', 'other']
const VOTES: readonly Vote[] = ['confirm', 'dispute']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TRY_AGAIN = 'Something went wrong. Please try again.'

export async function postSighting(input: NewSighting): Promise<ActionResult<Sighting>> {
  const problem = checkNewSighting(input)
  if (problem) return { ok: false, message: problem }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('sightings')
    .insert({
      lat: input.lat,
      lng: input.lng,
      category: input.category,
      agent_count: input.agentCount ?? null,
      vehicle_count: input.vehicleCount ?? null,
      location_label: input.locationLabel?.trim() || null,
      description: input.description?.trim() || null,
    })
    .select()
    .single()

  return error ? failure(error) : { ok: true, data }
}

export async function voteOnSighting(input: {
  sightingId: string
  vote: Vote
  myLat: number
  myLng: number
}): Promise<ActionResult<Sighting>> {
  if (!isRecord(input)) return { ok: false, message: TRY_AGAIN }
  if (!isInRange(input.myLat, -90, 90) || !isInRange(input.myLng, -180, 180)) {
    return { ok: false, message: 'Turn on location to confirm or dispute a sighting.' }
  }
  if (!UUID.test(String(input.sightingId)) || !VOTES.includes(input.vote)) {
    return { ok: false, message: TRY_AGAIN }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('vote_on_sighting', {
    target_sighting_id: input.sightingId,
    my_vote: input.vote,
    my_lat: input.myLat,
    my_lng: input.myLng,
  })

  return error ? failure(error) : { ok: true, data }
}

export async function deleteSighting(sightingId: string): Promise<ActionResult<null>> {
  if (!UUID.test(String(sightingId))) return { ok: false, message: TRY_AGAIN }

  const supabase = await createClient()
  const { error } = await supabase.rpc('delete_my_sighting', { target_sighting_id: sightingId })

  return error ? failure(error) : { ok: true, data: null }
}

// Server actions are public endpoints, so check the input even though the
// database enforces the same rules.
function checkNewSighting(input: unknown): string | null {
  if (!isRecord(input)) return TRY_AGAIN
  if (!isInRange(input.lat, -90, 90) || !isInRange(input.lng, -180, 180)) {
    return 'Pick a spot on the map first.'
  }
  if (!CATEGORIES.includes(input.category as Category)) return 'Choose what you saw.'
  if (!isCount(input.agentCount) || !isCount(input.vehicleCount)) {
    return 'Counts must be whole numbers from 0 to 99.'
  }
  if (!isOptionalText(input.locationLabel, 120)) return 'Keep the location under 120 characters.'
  if (!isOptionalText(input.description, 280)) return 'Keep the description under 280 characters.'
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOptionalText(value: unknown, maxLength: number): boolean {
  return value == null || (typeof value === 'string' && value.length <= maxLength)
}

function isInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function isCount(value: unknown): boolean {
  return value == null || (Number.isInteger(value) && isInRange(value, 0, 99))
}

function failure(error: PostgrestError): ActionResult<never> {
  // P0001 = a message from ICEPik's own database checks, written for users.
  if (error.code === 'P0001') return { ok: false, message: error.message }
  // 42501 = no session: the function's permission check or row-level
  // security refused it, usually because the session cookie expired.
  if (error.code === '42501') {
    return { ok: false, message: 'Your session has expired. Reload the page and try again.' }
  }
  return { ok: false, message: TRY_AGAIN }
}
```

```ts
// lib/supabase/admin.ts
import 'server-only'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/database.types'

/**
 * Supabase client with the SECRET key. It skips every database rule, so it is
 * used in exactly two places: account recovery (the password reset in
 * app/actions/recovery.ts) and push alerts (app/actions/push.ts, which
 * app/api/push/renew/route.ts calls). Never import it anywhere else, and never
 * give the key a NEXT_PUBLIC_ name.
 *
 * SUPABASE_SECRET_KEY is set in Vercel's Production environment only, marked
 * Sensitive. Preview deployments don't get it, so there this returns null, and
 * the reset and push alerts say they aren't available.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const secretKey = process.env.SUPABASE_SECRET_KEY
  if (!url || !secretKey) return null
  return createClient<Database>(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
```

```ts
// app/actions/recovery.ts
'use server'

// "Forgot password?" for saved accounts, using the recovery key shown when the
// account was saved. No email or phone is involved.
//
// Same rules as sightings.ts: check every argument, never console.log the
// input (it holds a password and a recovery key), and return errors as values.
// This is the only action that uses the secret key (lib/supabase/admin.ts).
//
// Usage from the reset page:
//   const result = await resetPasswordWithRecoveryKey({ username, recoveryKey, newPassword })
//   if (result.ok) showNewKeyOnce(result.data.newRecoveryKey), then sign in with the
//   new password (with a fresh CAPTCHA token: each token works only once)

import { createAdminClient } from '@/lib/supabase/admin'
import type { ActionResult } from '@/app/actions/sightings'

const USERNAME = /^[a-z0-9_]{3,20}$/
// One answer for unknown usernames and wrong keys.
const NO_MATCH = "That username and recovery key don't match."
const TRY_AGAIN = 'Something went wrong. Please try again.'
const KEY_NOT_REPLACED =
  "Your password was changed, but ICEPik couldn't make your new recovery key. Reset again with the same key to get one."

export async function resetPasswordWithRecoveryKey(input: {
  username: string
  recoveryKey: string
  newPassword: string
}): Promise<ActionResult<{ newRecoveryKey: string }>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, message: TRY_AGAIN }
  }
  const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : ''
  const recoveryKey = typeof input.recoveryKey === 'string' ? input.recoveryKey : ''
  const newPassword = typeof input.newPassword === 'string' ? input.newPassword : ''

  if (!USERNAME.test(username) || recoveryKey.length === 0 || recoveryKey.length > 64) {
    return { ok: false, message: NO_MATCH }
  }
  // Counted the way Supabase counts: at least 15 characters (code points), and
  // at most 72 bytes, bcrypt's limit, which Supabase refuses to go over.
  if (Array.from(newPassword).length < 15) {
    return { ok: false, message: 'Use a password of at least 15 characters. A few random words work well.' }
  }
  if (new TextEncoder().encode(newPassword).length > 72) {
    return { ok: false, message: 'That password is too long. Use up to 72 characters, fewer if it has accented letters or emoji.' }
  }

  // Only Vercel's Production environment has the secret key.
  const admin = createAdminClient()
  if (!admin) return { ok: false, message: "Password reset isn't available on this version of the site." }

  const { data: userId, error } = await admin.rpc('check_recovery_key', {
    p_username: username,
    p_key: recoveryKey,
  })
  if (error) return { ok: false, message: TRY_AGAIN }
  if (!userId) return { ok: false, message: NO_MATCH }

  // Sets the password and ends every session for this account, including on a
  // lost or seized phone. A device that's already signed in can still read and
  // post until its access token expires (the JWT expiry, 1 hour by default),
  // but it can't make a recovery key or delete the account.
  const { error: passwordError } = await admin.auth.admin.updateUserById(userId, {
    password: newPassword,
  })
  if (passwordError) {
    return {
      ok: false,
      message: passwordError.code === 'weak_password' ? 'Choose a stronger password.' : TRY_AGAIN,
    }
  }

  // Replace the used key, trying twice. The password has already changed, so
  // if both tries fail, say so: the used key still works, and resetting again
  // with it gives a new one.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: newRecoveryKey, error: keyError } = await admin.rpc('replace_recovery_key', {
      p_user_id: userId,
    })
    if (!keyError && newRecoveryKey) return { ok: true, data: { newRecoveryKey } }
  }
  return { ok: false, message: KEY_NOT_REPLACED }
}
```

### Sign in after the user accepts the terms

```ts
const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  // Only after the terms are accepted. CAPTCHA is required: send a fresh token.
  await supabase.auth.signInAnonymously({ options: { captchaToken } })
}
```

### Load the map

```ts
const { data: pins } = await supabase.from('sightings').select('*') // only active pins come back
```

### Keep the map live

```ts
supabase
  .channel('map')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'sightings' }, (change) => {
    if (change.eventType === 'DELETE') removePin(change.old.id)
    else upsertPin(change.new) // INSERT or UPDATE: a new pin, new counts or a later expiry
  })
  .subscribe()
```

Pins expire without sending an event, so remove any pin whose `expires_at` has passed at least once a minute. Missed events aren't replayed: reload the pins when the app returns to the foreground or reconnects.

### Post a sighting

```ts
import { postSighting } from '@/app/actions/sightings'

const result = await postSighting({
  lat, lng, category: 'vehicle', agentCount: 3, vehicleCount: 2,
  locationLabel: 'Broad St & Girard Ave', description,
})
if (!result.ok) showMessage(result.message)
```

The database rounds the location and sets the time, expiry and counts. The new pin also reaches every open map through Realtime.

### Confirm or dispute

```ts
import { voteOnSighting } from '@/app/actions/sightings'

const result = await voteOnSighting({
  sightingId: pin.id,
  vote: 'confirm', // or 'dispute'; voting again switches it
  myLat, myLng,    // the device's current GPS fix
})
if (!result.ok) showMessage(result.message)
```

Votes can be switched but not removed.

### Check a saved place or a dropped pin

For home and work, filter the pins already on the phone, so those places never leave it. This is the same distance formula the server uses, so it also works for the 1 km vote pre-check.

```ts
const toRad = (d: number) => (d * Math.PI) / 180
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)))
}

const nearHome = pins.filter((p) => distanceMeters(home.lat, home.lng, p.lat, p.lng) <= 1609)
```

For a pin dropped on the map (never home or work), the server can do the search and return `distance_m` with each pin:

```ts
const { data: nearby } = await supabase.rpc('sightings_near', { pin_lat, pin_lng, radius_m: 1609 })
```

### My posts, my votes, deleting a post

```ts
import { deleteSighting } from '@/app/actions/sightings'

const { data: myPosts } = await supabase.from('sighting_reporters').select('sighting_id')
const { data: myVotes } = await supabase.from('sighting_votes').select('sighting_id, vote')
const result = await deleteSighting(pinId) // your own active pin only
```

### Settings

```ts
const { data: profile } = await supabase
  .from('profiles').select('preferred_language, sightings_posted, votes_cast').single()
await supabase.rpc('set_my_language', { new_language: 'es' })

// Change password: "Require current password" is on, so send the current one too
const { error } = await supabase.auth.updateUser({ password: newPassword, current_password: currentPassword })
if (error) showAuthError(error.code) // current_password_invalid, same_password, weak_password, …

// "Make a new recovery key": ask for the password and a fresh CAPTCHA token first.
// The database makes a key only within 10 minutes of a password sign-in, and only
// while that session exists. End the session the sign-in replaces.
const { data: { session: before } } = await supabase.auth.getSession()
const { error: signInError } = await supabase.auth.signInWithPassword({ email: before!.user.email!, password, options: { captchaToken } })
if (signInError) return showAuthError(signInError.code) // invalid_credentials → "Wrong password"
if (before) await supabase.auth.admin.signOut(before.access_token, 'local').catch(() => undefined)
const { data: newRecoveryKey, error: keyError } = await supabase.rpc('create_recovery_key') // the old key stops working
if (keyError) return showMessage(keyError.message)
```

### Save the account, log in on another device

```ts
// Usernames: 3–20 lowercase letters, numbers or underscores. The database refuses
// anything else but reports it only as unexpected_failure, so check first.
const name = username.trim().toLowerCase()
if (!/^[a-z0-9_]{3,20}$/.test(name)) return showMessage('Use 3 to 20 lowercase letters, numbers or underscores.')
const loginId = `${name}@icepik.invalid`

// Save: same user id, posts and votes kept
const { error: saveError } = await supabase.auth.updateUser({ email: loginId, password })
if (saveError) return showAuthError(saveError.code) // email_exists → "That username is taken"

// Sign in with the new password (fresh CAPTCHA token), end the session it replaces,
// then show the recovery key once. If a step fails, the account is still saved;
// has_recovery_key() catches it later.
const { data: { session: before } } = await supabase.auth.getSession()
const { error: signInError } = await supabase.auth.signInWithPassword({ email: loginId, password, options: { captchaToken } })
if (!signInError && before) await supabase.auth.admin.signOut(before.access_token, 'local').catch(() => undefined)
const { data: recoveryKey } = await supabase.rpc('create_recovery_key')
if (recoveryKey) showKeyOnce(recoveryKey)
else showMessage('Your account is saved. Make your recovery key in Settings.')

// Log in on another device
const { data: { session }, error } = await supabase.auth.signInWithPassword({ email: loginId, password, options: { captchaToken } })
if (error) return showAuthError(error.code) // invalid_credentials → "Username or password is wrong"
const isSaved = session?.user.is_anonymous === false
const { data: hasKey } = await supabase.rpc('has_recovery_key') // false → ask once to make one
```

The `.invalid` ending can never receive email, so nobody can reset another user's password by email, and Supabase can't send a reset either. The recovery key is the only way back in after a forgotten password.

### Forgot password

The log-in screen's "Forgot password?" asks for the username, the recovery key and a new password.

```ts
import { resetPasswordWithRecoveryKey } from '@/app/actions/recovery'

// demo: true only on /demo, where any letters and numbers work as the key
const result = await resetPasswordWithRecoveryKey({ username, recoveryKey, newPassword }, demo)
if (!result.ok) showMessage(result.message)
else {
  showNewKeyOnce(result.data.newRecoveryKey) // the used key no longer works
  const loginId = `${username.trim().toLowerCase()}@icepik.invalid`
  // CAPTCHA tokens work once: get a fresh one for this sign-in
  const { error } = await supabase.auth.signInWithPassword({ email: loginId, password: newPassword, options: { captchaToken } })
  if (error) showAuthError(error.code)
}
```

A reset ends every session on the account, including on a lost or seized phone, and replaces the used key with a new one. A device that's already signed in can still read and post until its access token expires (the JWT expiry, 1 hour by default), but it can't make a recovery key or delete the account: those check that its session still exists. To sign it out sooner, call `supabase.auth.getUser()` when the app opens or comes back to the foreground: supabase-js clears the session itself when Supabase says it no longer exists. Don't sign out on any other error, such as being offline: for an unsaved account that would lose it for good. Without the key, the account can't be recovered and the user starts a new one.

### Delete the account

```ts
// A saved account (one with a login ID) signs in with its password first, with a
// fresh CAPTCHA token: the database deletes one only within 10 minutes of a
// password sign-in, from a session that still exists. Anonymous accounts skip this.
if (user.email) {
  const { data: { session: before } } = await supabase.auth.getSession()
  const { error: signInError } = await supabase.auth.signInWithPassword({ email: user.email, password, options: { captchaToken } })
  if (signInError) return showAuthError(signInError.code) // invalid_credentials → "That password is wrong"
  // End the session the sign-in replaced; this needs only that session's own token
  if (before) await supabase.auth.admin.signOut(before.access_token, 'local').catch(() => undefined)
}
const { error } = await supabase.rpc('delete_my_account')
if (error) return showMessage(error.code === 'P0001' ? error.message : 'Something went wrong. Please try again.')
await supabase.auth.signOut({ scope: 'local' }) // the account is gone, so just clear this device
```

## Rules and limits

The server enforces all of these. Mirror them in the app so people see a rule before they run into it.

| Rule | Value |
| --- | --- |
| Pin lifetime | 4 hours from posting |
| Extension | A person's first vote on a pin, if it's a confirmation, keeps the pin up at least 2 more hours; switching a dispute to a confirmation later doesn't |
| Location rounding | 3 decimals: about 111 m north–south and 85 m east–west in Philadelphia |
| Posting limit | 5 posts per account per clock hour; deleting a post doesn't free a slot |
| Vote distance | Within 1 km of the pin |
| Votes | One per person per pin; can be switched, not removed; not on your own pin or an expired one |
| Verified | 2+ confirmations and at least twice as many confirmations as disputes |
| Disputed | 2+ disputes that outnumber confirmations |
| Verification score | (confirmations + 1) ÷ (confirmations + disputes + 2) |
| Text limits | Label 120 characters, description 280, agent and vehicle counts 0–99 |
| Private record cleanup | Hourly, for pins that have expired |
| Passwords | At least 15 characters (Supabase counts them as Unicode characters) and at most 72 bytes; Supabase refuses longer ones (bcrypt's limit). Letters with accents take 2 bytes, emoji 4 |
| Recovery key | 128 random bits shown once as 8 groups of 4; only a SHA-256 hash is stored; single use, replaced after every reset or on request |
| Username | 3–20 lowercase letters, numbers or underscores; can't be changed once saved |
| Making a recovery key | Only within 10 minutes of signing in with the password, from a session that still exists |
| Deleting a saved account | Only within 10 minutes of signing in with the password, from a session that still exists; anonymous accounts need no password |

## Errors to handle

ICEPik's own checks return `error.code` `P0001` with a message written for users: show it as is. The server actions return only a message: ICEPik's own, one from their input checks (such as "Pick a spot on the map first." or "Choose what you saw."), the session message below, or "Something went wrong. Please try again." for anything else. For Supabase Auth errors, check `error.code`, never the message text ([error codes](https://supabase.com/docs/guides/auth/debugging/error-codes)).

| Error | When | What the app should do |
| --- | --- | --- |
| "You can post up to 5 sightings an hour. Try again later." | 6th post in a clock hour | Show it and keep what the user typed |
| "You need to be within 1 km of a sighting to confirm or dispute it." | Voter is too far away | Show it; your pre-check should usually prevent this |
| "Turn on location to confirm or dispute a sighting." | No location sent | Ask for location permission |
| "This sighting has expired." | Voting on an expired pin | Remove the pin from the map |
| "This sighting no longer exists." | The reporter deleted it | Remove the pin from the map |
| "You can't confirm or dispute your own sighting." | Voting on your own pin | Hide the vote buttons on your own pins |
| "Your session has expired. Reload the page and try again." | A server action (posting, voting, deleting a pin) ran without a valid session | Run the sign-in step again (`getSession`, then `signInAnonymously` if there is none) and retry |
| Code `42501`, "permission denied for function …" | A browser `rpc()` (language, recovery key, delete account) ran without a session | Sign in again the same way; if a session exists, it's an app bug |
| Code `42501`, "violates row-level security policy" | Writing a table directly | App bug: use the calls in "How to call it" |
| Code `23514` (check constraint) | set\_my\_language with a value that isn't 2–10 characters | App bug: send a language code such as en or es |
| Auth `email_exists` or `user_already_exists` | Username already taken when saving | Say "That username is taken" |
| Auth `invalid_credentials` | Wrong username or password | Say "Username or password is wrong" |
| Auth `weak_password` | Password fails the project's strength setting | Show the password rules |
| Auth `captcha_failed` | CAPTCHA token missing or rejected | Show the CAPTCHA again |
| Auth `over_request_rate_limit` | Too many auth requests from one network | Ask them to try again later |
| Auth `anonymous_provider_disabled` | Anonymous sign-ins are off in Supabase | Ask the backend owner to turn them on |
| Auth `current_password_required` or `current_password_invalid` | Changing the password without the right current password | Say "Your current password is wrong" |
| Auth `same_password` | The new password is the same as the old one | Say "Choose a different password" |
| Auth `unexpected_failure` when saving | The username breaks the rule (the database refused it), or Supabase had a problem | Check the username before saving; otherwise ask them to try again |
| "You can only delete active sightings you posted." | Deleting a pin that isn't yours, or has expired | Show Delete only on your own active pins |
| "Save your account with a username and password first." | Asking for a recovery key on an unsaved account | Save the account first |
| "Enter your password again to make a recovery key." | No password sign-in in the last 10 minutes, or that session has ended (for example by a reset) | Ask for the password, sign in with it (fresh CAPTCHA token), then ask again |
| "Enter your password again to delete your account." | Deleting a saved account with no password sign-in in the last 10 minutes, or from a session that has ended | Ask for the password, sign in with it (fresh CAPTCHA token), then delete again |
| "That username and recovery key don't match." | Wrong key, unknown username, or a key that was already used | Let them try again; the answer is the same in every case |
| "Use a password of at least 15 characters. A few random words work well." | New password under 15 characters | Show the rule next to the field |
| "That password is too long. Use up to 72 characters, fewer if it has accented letters or emoji." | New password over 72 bytes | Show the rule next to the field |
| "Choose a stronger password." | Supabase rejected the new password as weak | Suggest a longer passphrase; the key was not used up |
| "Your password was changed, but ICEPik couldn't make your new recovery key. Reset again with the same key to get one." | The reset worked but making the new key failed twice | Show it as is; the used key still works once more |
| "Password reset isn't available on this version of the site." | A deployment without `SUPABASE_SECRET_KEY` (Preview or local) | Expected outside Production; test the reset there or on the scratch project |
| "The demo's password reset isn't set up yet." | The reset on `/demo`, on a deployment without `DEMO_SUPABASE_SECRET_KEY` | Add the demo project's secret key in Vercel (Production, Sensitive) |
| "On the demo, the key can be any letters and numbers." | The reset on `/demo` with other characters in the key | Show it as is |

## What we need from you

The server enforces the data rules; these are the parts only the app can get right. Everything here is required for the MVP unless it's marked **Should**.

### Protect people's locations

- **Keep saved places on the phone.** Store home and work in device storage only, and check them against loaded pins with `distanceMeters`. A server copy would be a list of where immigrants live.
- **Send the phone's location only when voting.** It goes to the `voteOnSighting` server action at the moment of the vote and nowhere else: no caching, logs, analytics or crash reports. Don't add third-party SDKs that collect location or user ids.
- **Label pins with street names, not addresses.** Reverse-geocode the rounded point and keep cross streets or "1200 block of …". The server's house-number removal is only a backstop.
- **Warn before free text.** Put a hint on the description field: no names or home addresses. Descriptions are public and nobody moderates them.
- **Guard the session and keys.** Let `@supabase/ssr` keep the session in cookies. The publishable key is the only key in the browser; never ship the secret key or give it a `NEXT_PUBLIC_` name.

### Keep locations out of the web stack

Supabase, Vercel and CARTO's tile servers all see every visitor's IP address and log each request URL next to it. These rules keep those logs from tying anyone to a place.

- **Pin writes go through the server actions only.** Never insert into `sightings` or call `vote_on_sighting` or `delete_my_sighting` from the browser client: the user's IP would reach Supabase with the request. Account calls (language, recovery key, saving and deleting the account) run in the browser.
- **No ids or coordinates in URLs.** Change settings with `rpc()`, and never call `rpc()` with `{ get: true }`. Never put coordinates in a page URL, query string or hash: they also land in browser history.
- **Saved places stay in the browser.** Keep home and work in `localStorage` only, never in cookies, which travel to Vercel with every request.
- **No third-party code.** No analytics, session replay, ads or tag managers, and leave Vercel Web Analytics and Speed Insights off. Bundle Leaflet from npm rather than a CDN, and self-host fonts with `next/font`. Set a Content-Security-Policy that allows only your own origin, your Supabase project, CARTO's `*.basemaps.cartocdn.com` and the CAPTCHA provider (`challenges.cloudflare.com`).
- **Load the map only after the user agrees to the privacy policy.** Leaflet fetches CARTO's Positron tiles from `*.basemaps.cartocdn.com` (through `leaflet-providers`, with the free key in `NEXT_PUBLIC_CARTO_KEY`), whose servers record each visitor's IP and which tiles, and so which area, they load. Keep the OpenStreetMap and CARTO attribution visible. CARTO's terms forbid proxying or caching tiles on a server.
- **The vector map.** Where the browser has WebGL 2, MapLibre GL draws the map from CARTO's vector tiles instead of the Positron images, and lets it zoom in two steps further. Bundle MapLibre from npm like Leaflet, with its worker served from your own origin; the worker is a static file the page's policy doesn't reach, so `next.config.ts` gives it its own Content-Security-Policy allowing only CARTO's two vector hosts. The Content-Security-Policy's `connect-src` then also allows `https://basemaps.cartocdn.com` and `https://tiles.basemaps.cartocdn.com`, for the map's style, tiles, fonts and icons, which carry no key. Without WebGL 2, or when the style or the vector tiles can't be loaded, the map falls back to the images.
- **Keep the browser's default referrer policy.** `strict-origin-when-cross-origin` sends other sites only your domain, never the page path. Don't use `no-referrer`: a CARTO key restricted to your website is checked against the Referer.
- **Geocode on the server.** Call the reverse geocoder (and Google Translate, later) from a route handler with only the rounded point, so the provider sees Vercel's IP. Never `console.log` request bodies or coordinates: Vercel keeps runtime logs.
- **Protect shared devices.** Add "Clear this device" in Settings to delete saved places and sign out. Once push alerts exist, it turns them off too, as "Keep the server in step" under "Push alerts" says, before it clears anything. If the account isn't saved, say that this ends it for good and offer Save account first. Keep street names out of page titles, which show in tabs and history.
- **Don't drop new pins on the reporter's GPS position.** Let them place the pin, and suggest posting after they've left the area: a fresh pin shows roughly where its reporter is standing.
- **Snap every new pin in the browser, and send only the snapped spot.** `snapToPinnable()` (`lib/pinnable.ts`) moves a tapped, dragged or searched point to the nearest point on the 0.001° grid that is on land and within 200 m of a road or footpath, using CARTO's vector map tiles for that area. Before checking, the map zooms in to the spot (Leaflet zoom 16) and waits for the vector map to load it, so the check reads the same tile URLs from the browser's cache. In testing at 375 px wide and up, every check's tiles came from the cache. On a 320 px wide phone, a check that reads the whole 500 m box (the nearest grid point isn't pinnable) fetched 1 or 2 of its 4 tiles from CARTO, because that screen shows less than the box. Without WebGL 2 the map shows images and has no vector tiles, so each check downloads CARTO's style once and up to about nine zoom-15 vector tiles around the spot at the moment a pin is placed: CARTO and its CDN could then link an IP address to the area of a pin that goes public moments later. If CARTO's vector tiles can't be reached, the check fails closed ("Couldn't check this spot. Try again.") and no pin is placed. It sends CARTO tile numbers only, never coordinates. The exact point, including a searched address's coordinates, never leaves the browser: only the snapped spot goes to `/api/reverse` and `postSighting`. Existing pins are left as they are.
- **Take pins only where ICE works.** `lib/service-area.ts` holds the outline of the 50 states, DC, Puerto Rico, the U.S. Virgin Islands, Guam and the Northern Mariana Islands (README, section 6). The browser checks it first, with no network request, and refuses anything outside before reading any map tiles. `postSighting` checks the same outline on the server and refuses a point outside, so a direct call can't post one. The database itself doesn't check this: a rule in the `sightings` insert policy or a trigger would be the place, if we want it there too.

### Keep the server actions safe

Server actions are public endpoints: anyone can call one directly with any input, without using the app. Next.js already blocks cross-site form posts and hides thrown error details. Everything else is up to us.

- **Check every argument at runtime.** TypeScript types aren't enforced when a request arrives. `sightings.ts` checks types, ranges and lengths before touching the database; any new action must do the same.
- **Build database rows field by field.** Never pass the caller's object into `.insert()` or `.update()`, or they could set fields such as `expires_at`.
- **Take the user from the session, never from the input.** Don't add a `userId` argument: the database already knows who is calling. If an action ever needs the user on the server, use `supabase.auth.getClaims()`, never `getSession()`.
- **Keep the secret key in one place.** Only the password reset (`app/actions/recovery.ts`) and push alerts (`app/actions/push.ts`, which `app/api/push/renew/route.ts` calls) may use a secret key, through lib/supabase/admin.ts (`createAdminClient()` for the real project, `createDemoAdminClient()` for the demo's reset); never create a secret-key client anywhere else, and never use the cookie client for push. It skips every database rule, so a mistake there lets any visitor do anything.
- **Return only what the screen needs**, and pass on only ICEPik's own error messages (`P0001`). Everything else becomes "Something went wrong."
- **Keep Next.js's defaults.** Don't add `serverActions.allowedOrigins` or raise `bodySizeLimit` without checking with the backend owner.
- **Keep server code out of the browser.** `lib/supabase/server.ts` starts with `import 'server-only'`, so the build fails if a client component imports it.
- **Rate-limit actions in Vercel's firewall.** The Hobby plan includes one rate-limit rule: match POST requests that carry a `Next-Action` header, count per IP, and allow about 30 a minute. Run it in Log mode for a day first. When it trips, the action call throws in the browser: catch it and show "Too many tries. Wait a minute."
- **Test with hostile input.** Call each action directly with missing, wrong-type and oversized arguments. Each must return a message and write nothing.

### Keep the map live and honest

- Subscribe to Realtime and handle insert, update and delete events.
- Drop pins whose `expires_at` has passed, checking at least once a minute. Reload pins when the app returns to the foreground or reconnects.
- Show each pin's `verification_status`, its confirm and dispute counts, and how long ago it was posted. Disputed pins must look clearly different from verified ones.
- Cluster pins: rounding puts nearby reports on exactly the same coordinates.
- **Should:** before posting, show active pins within about 200 m and offer to confirm one instead. One event then stays one pin.

### Posting and voting

- Mirror the limits in the post form: the five categories, counts 0–99, label 120 characters, description 280.
- Show Confirm and Dispute only when the vote can succeed: not your pin (`myPosts`), not expired, within 1 km (`distanceMeters`), location on. Still show the server's message if it fails.
- Show the user's current vote from `myVotes` and let them switch it.
- Show Delete only on the user's own active pins.

### Accounts

- On the first visit, show the terms of service and privacy policy before anything else loads: no sign-in, map tiles or CAPTCHA yet. Once the user agrees, sign in anonymously and go straight to the map, with no sign-up screen. Keep the accepted policy version in localStorage, ask again when it changes, and send nothing about the agreement to the server.
- Put "Save account" and "Log in" in Settings. Usernames are 3–20 lowercase letters, numbers and underscores, and can't be changed once saved. Check the format before saving: the database refuses anything else, but Supabase reports that only as a generic error. Passwords need at least 15 characters and at most 72 bytes (letters with accents take 2, emoji 4); suggest a few random words.
- On the save screen, warn people not to use their real name. Then show the recovery key once: offer Copy, tell them to write it on paper or keep it in a password manager (not in a file or note on this device), and ask them to confirm they've stored it. Say plainly that anyone holding the key can reset the password, and that without it a forgotten password means a new account.
- Put "Delete my account" in Settings with a confirmation step. Users must be able to erase their account and its private records themselves. For a saved account, ask for the password and sign in with it first (fresh CAPTCHA token): the database deletes a saved account only within 10 minutes of a password sign-in.
- CAPTCHA is required: pass a `captchaToken` to every `signInAnonymously` and `signInWithPassword` call. Each token works once, so get a fresh one for every call.
- Put "Forgot password?" on the log-in screen: username, recovery key and a new password, then show the new key once.
- In Settings, add "Make a new recovery key" for when someone thinks theirs was seen. It asks for the password and signs in with it first, because the database makes a key only within 10 minutes of a password sign-in. Ask for the current password when changing the password too.
- After a saved account logs in, call has\_recovery\_key(). If it returns false (an interrupted save, or an account from before recovery keys), ask once to make one.

## Push alerts

Phones can ask for a push alert when a new sighting appears near a saved place (Home, Work and custom places, at most 5 switched on) or, if the person opts in, near where they last opened ICEPik. One alert distance covers all places: 1, 2 or 5 miles (1 by default). The server side is built; the phone's side comes in later handoffs.

Every push is shown, with its real distance from the nearest watched place, because browsers require a visible notification for each push: Safari revokes a site's push permission when pushes arrive without one, and Chrome shows its own notice instead. iPhones support neither quiet notifications nor replacing one notification with another. So the phone can't drop a pin that's farther than the chosen distance: the squares (below) decide who gets an alert. With ~2.2 km squares, 0.25, 0.5 and 1 mile list exactly the same squares for every place south of 55°N, which covers the contiguous US, Hawaii and the territories; they differ only in Alaska north of 55°N. So the choices are 1, 2 and 5 miles. An alert can come from farther than the chosen distance, up to about 4 miles away at 1 mile:

| Alert distance | Squares per place at 25°N / 40°N / 49°N | Farthest alert at 25°N / 40°N / 49°N |
| --- | --- | --- |
| 1 mile (default) | 9 / 9 / 9 | 4.3 / 3.9 / 3.6 miles |
| 2 miles | 21 / 25 / 25 | 5.6 / 5.9 / 5.5 miles |
| 5 miles | 65 / 77 / 87 | 8.6 / 8.8 / 8.4 miles |

The farthest alert is for a place in one corner of its square and a sighting in the far corner of the farthest square listed. The setting's wording will tell people that some alerts may be a little farther away. The server, the squares and the privacy model don't change.

### What the server stores

`public.push_subscriptions`, one row per phone:

| Column | What it is |
| --- | --- |
| `id` | Random UUID. The phone keeps it |
| `endpoint`, `p256dh`, `auth` | The browser's push subscription. The endpoint must be `https://` on Chrome's (`fcm.googleapis.com` or `jmt17.google.com`), Apple's (`web.push.apple.com`), Mozilla's (`updates.push.services.mozilla.com`) or Microsoft's (`*.notify.windows.com`) push service, at most 1,024 characters, so the sender can never be aimed at another URL |
| `cells` | 1 to 1,000 square ids, sorted, without repeats |
| `secret_hash` | SHA-256 of a random 32-byte device secret that only the phone holds |
| `created_on`, `expires_on` | Dates, never times. A row expires 30 days after the app was last opened |

There is no user id. RLS is on with no policies, the browser roles have no grants, and every push function can be called only with the secret key, so nobody can skip the server's checks with the public key. The server actions use `createAdminClient()`, which sends no user session, so Supabase's logs can't tie a subscription request to an account.

`public.push_vapid_tokens`, one row per push service, holds the sender's signed VAPID token for it, shared by every run of the sender (see "The sender" below):

| Column | What it is |
| --- | --- |
| `origin` | The push service's `https://` origin, such as `https://web.push.apple.com`, with no path and no port. Same list of push services as `endpoint` above. The primary key |
| `public_key` | The VAPID public key the token was signed with (87 characters) |
| `subject` | The contact (`VAPID_SUBJECT`) the token names, at most 512 characters |
| `header` | The whole `Authorization` value, `vapid t=<token>, k=<public key>`, at most 2,048 characters. Its `k=` must be `public_key` |
| `expires_at` | When the token expires (its `exp`) |

RLS is on with no policies and the browser roles have no grants, so only the secret key reaches it, through `push_vapid_get` and `push_vapid_put`. It never holds the private key. Keeping a token here is acceptable: it expires within 12 hours (the sender signs it for 12, and `push_vapid_put` refuses an expiry more than 24 hours ahead), and it is useless without push endpoints, which only the secret key can read.

### The squares

A square ("cell") is a fixed grid square 0.020° of latitude by 0.026° of longitude, about 2.2 km × 2.2 km at 40°N. Its id is `row * 20000 + col`, worked out in whole thousandths of a degree so the phone (`cellOf()` in `lib/push-cells.ts`) and Postgres (`public.push_cell()`) always agree, even for a pin exactly on an edge (pins are rounded to 0.001°). For each place, the phone sends every square within the alert distance of **the square that holds the place** (`cellsAround()`). That list depends only on which square the place is in, never on where in the square it sits, so the server can't place anyone more precisely than one square, at any alert distance. Five places and the last-opened spot at 5 miles stay under 1,000 squares anywhere in the US (906 at Utqiaġvik, Alaska). Every push is shown, with its real distance from the nearest watched place, because browsers require a visible notification for each push. The phone works out that distance and writes the alert text itself, so the alert's wording never reaches the server.

What the squares don't protect: the server still knows which ~2.2 km squares a phone watches, and a square around someone's home narrows down where they live. Each push service (Google, Apple, Mozilla or Microsoft) sees when a phone gets an alert, though not what it says, and those times can be matched with the public sightings' `created_at` to guess which squares a phone watches. Push service and Supabase logs can be demanded like any other records.

### Functions and the cleanup job

See the table under "Server functions" above. In short: `push_create`, `push_update` and `push_delete` for the server actions; `push_targets` and `push_drop` for the sender, and `push_vapid_get` and `push_vapid_put` for its shared token; `push_cell` and `push_purge` for the database itself. Errors: `push_endpoint_taken` (that endpoint is already saved), `push_invalid` (bad secret or cells, an endpoint without its keys, or a token expiry that is missing, past or more than 24 hours ahead), and the tables' checks.

`pg_cron` runs `purge-push-subscriptions` every day at 04:17 UTC: `select public.push_purge()` deletes subscriptions whose `expires_on` has passed and tokens whose `expires_at` has passed.

### In the app

- `lib/push-cells.ts`: the grid maths and the distance choices (`ALERT_DISTANCES_MI`, 1, 2 and 5 miles, and `DEFAULT_ALERT_DISTANCE_MI`, 1), with no imports, shared by the pages and the service worker. Must match `push_cell()`.
- `lib/turnstile.ts`: checks a Turnstile token with Cloudflare's siteverify, using `TURNSTILE_SECRET_KEY`, the action `alerts`, and a 5-second limit. It never sends the visitor's IP address. Without the secret, every Vercel deployment (previews too, as they use the real database) refuses with `not_configured`; only a local run with no `VERCEL_ENV` skips the check, for the checks against `scripts/mock-supabase.mjs`.
- `app/actions/push.ts`: `createPushSubscription` (needs a Turnstile token), `updatePushSubscription` and `deletePushSubscription` (need the device secret). Each returns `{ ok: true, data }` or `{ ok: false, error, message }`, where `error` is `invalid`, `captcha`, `endpoint_taken`, `not_found`, `not_configured` or `failed`.
- `app/api/push/renew/route.ts`: `POST` only, JSON body `{ id, secret, endpoint, p256dh, auth }`, for the service worker to swap in a new endpoint. Empty answers with `Cache-Control: no-store`: 204 done, 400 bad input (or the endpoint is taken), 403 cross-site (`Sec-Fetch-Site` other than `same-origin`) or wrong id or secret, 503 not set up or the database failed.

What the phone side does (built in handoff 4; `scripts/alerts-flows.mjs` checks each point against `scripts/mock-supabase.mjs`):

- **Where it lives.** `public/sw.js` (the service worker: `push`, `notificationclick` and `pushsubscriptionchange`, no `fetch` handler and no cache; served by `next.config.ts` with its own CSP, and skipped by `proxy.ts`); `lib/alerts/client.ts` (the API the screens use: `alertSupport`, `prepareAlerts`, `releaseAlerts`, `enableAlerts`, `disableAlerts`, `updateAlertSettings`, `useAlertSettings`); `lib/alerts/idb.ts` (the `icepik-alerts` IndexedDB copy the worker reads); `lib/alerts/upkeep.ts` (refresh on open, pending open, the in-app notice); `lib/alerts/strings.ts` (every text); `app/_components/alerts-settings.tsx` (Settings → Alerts, on `/` only); the alerts section of `policy.tsx`. The settings live in `localStorage` under `icepik.alerts` (no id, secret or endpoint there; those are in IndexedDB).
- **Nothing exists before it's asked for.** No service worker and no IndexedDB database until the person opens Settings → Alerts (after consent, on `/`); leaving that screen with alerts off removes them again. `/demo` has no Alerts entry and registers nothing; its Clear this device still runs the teardown.

- **Show a notification for every push.** In the service worker's `push` handler, show one inside `event.waitUntil()`, even for a pin farther away than the chosen distance: a push with no notification makes Safari revoke the site's push permission, and Chrome shows its own notice instead. Say how far the sighting is from the nearest watched place, and which place that is.
- **Use the sighting id as the notification's tag.** The message's `id` goes in `tag`, so a repeat of the same sighting replaces the first where the browser supports it. iPhones may not: same-tag notifications don't replace each other on iOS (WebKit bug 258922), which is why the sender never repeats a follow-on call that may have run (see "No second chances" below).
- **Subscribe inside the tap handler itself.** Call `pushManager.subscribe()` directly in the handler of the tap that turns alerts on, before anything that waits, as Apple asks. Then run the Turnstile check and `createPushSubscription`.
- **Keep the server in step.** The phone can't hide a push, so every way of stopping or narrowing alerts has to reach the server. Turning alerts off and "Clear this device" call `deletePushSubscription` with the stored id and device secret before clearing them, then `PushSubscription.unsubscribe()`, even if the delete failed (the push service then answers 404 or 410, and the sender drops the row). Clear also deletes the service worker's own copy of the places. Otherwise the next person on a shared phone sees alerts for the last person's squares, and turning alerts on again fails with `endpoint_taken`, because the browser keeps its old subscription. Every other change to what is watched calls `updatePushSubscription` with the new squares: adding, moving or removing a place, switching one on or off, changing the distance, turning the last-opened option on or off, and a new last-opened spot. With nothing left to watch, turn alerts off as above. A change is done only when `updatePushSubscription` answers `{ ok: true }`; until then the server keeps sending for the old squares. If the call fails (no network, `failed` or `not_configured`), keep the change pending and send it again, with the current squares, when the app next opens or the network is back. `not_found` means the server has no row and sends nothing, so show its message. The renewal each time the app opens sends the current squares too, because an update without `cells` keeps the old ones.
- **Offer the distance choices.** The setting offers `ALERT_DISTANCES_MI`, with `DEFAULT_ALERT_DISTANCE_MI` chosen at first, and its wording says that some alerts may be a little farther away.
- **Show the warning first.** Turning alerts on needs the warning's box ticked, a place switched on and a Turnstile token (action `alerts`; none when the check is off locally). The tap calls `enableAlerts()` with no `await` before it, so `subscribe()` is the first thing that waits. The last-opened option has its own warning with Turn on and Cancel. The notification text is private by default; the "Show place and distance in alerts" switch turns the detailed text on.
- **Refresh on open** (and when the page becomes visible again, at most hourly): register the worker again, drop alerts if permission or the browser's subscription is gone (`blocked`), send a changed endpoint, send the current squares plus any change still `pending` (this renews the 30 days), and drop alerts on `not_found` (`expired`). Changes to places that leave nothing to watch turn alerts off (`no-places`) with a notice. A tap on a notification opens `/` (never `/demo`) and the app reads `pendingOpen` from IndexedDB to show the sighting.

### Owner steps for push

Do these on your own computer and in the dashboards. The real project only: `/demo` has no push alerts, so never run the push migration on the demo project.

1. **VAPID keys.** On your own computer, make a key pair with Node 20 or later (the app already needs it); nothing is added to the repository. Save this as `vapid-keys.mjs` in a folder outside the repository (your Desktop, say) and run `node vapid-keys.mjs` there:

   ```js
   // vapid-keys.mjs: makes a VAPID key pair (ES256, P-256) with Node's built-in WebCrypto.
   const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
   const jwk = await crypto.subtle.exportKey("jwk", privateKey);
   const point = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
   console.log("Public key (NEXT_PUBLIC_VAPID_PUBLIC_KEY, for Vercel):");
   console.log(Buffer.from(point).toString("base64url"));
   console.log("\nPrivate key (VAPID_PRIVATE_JWK, for Supabase):");
   console.log(JSON.stringify({ alg: "ES256", ...jwk }));
   ```

   It prints a public key (87 characters, for the app) and a private key as one line of JWK JSON (for the sender). Keep the private key out of Vercel, the repository and chats; step 2 of "The sender" below says where it goes. Make the pair once: a new pair makes every saved subscription useless (see "What to know" below).
2. **Vercel.** In the project, open Settings → Environment Variables, and add for the **Production** environment:
   - `NEXT_PUBLIC_VAPID_PUBLIC_KEY`: the public key from step 1, type **Config** (it's built into the page, so it isn't secret).
   - `TURNSTILE_SECRET_KEY`: the secret key of the same Turnstile widget that Supabase Auth's CAPTCHA uses (Cloudflare dashboard → Turnstile → the widget → its secret key), type **Secret** (write-only after saving; Vercel used to call these "Sensitive"). Never give it a `NEXT_PUBLIC_` name.
   Then redeploy: changes apply only to new deployments.
3. **Supabase, real project only.** SQL Editor → New query → paste `database/migrations/20261125_push_subscriptions.sql` → Run. The last statement should show `129944032`. Check again any time with `select public.push_cell(39.952, -75.164);` (expect `129944032`), and see the job with `select jobname, schedule from cron.job where jobname = 'purge-push-subscriptions';`.
4. **Check after the migration.** The migration was tried only in a stand-in Postgres (a test copy of Supabase's roles, with `pg_cron` replaced), so confirm the real project before going on. SQL Editor → New query → paste this → Run. It only reads:

   ```sql
   select n, "check", result, should_be, result = should_be as ok
   from (
     select 1 as n, 'RLS is on for push_subscriptions' as "check",
            (select relrowsecurity::text from pg_class where oid = 'public.push_subscriptions'::regclass) as result,
            'true' as should_be
     union all
     select 2, 'row policies on push_subscriptions',
            (select count(*)::text from pg_policies where schemaname = 'public' and tablename = 'push_subscriptions'),
            '0'
     union all
     select 3, 'anon has a table privilege on push_subscriptions',
            has_table_privilege('anon', 'public.push_subscriptions', 'select,insert,update,delete,truncate,references,trigger')::text,
            'false'
     union all
     select 4, 'authenticated has a table privilege on push_subscriptions',
            has_table_privilege('authenticated', 'public.push_subscriptions', 'select,insert,update,delete,truncate,references,trigger')::text,
            'false'
     union all
     select 5, 'anon or authenticated has a column privilege on push_subscriptions',
            (has_any_column_privilege('anon', 'public.push_subscriptions', 'select,insert,update,references')
             or has_any_column_privilege('authenticated', 'public.push_subscriptions', 'select,insert,update,references'))::text,
            'false'
     union all
     select 6, 'push functions in public',
            (select count(*)::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace
              where s.nspname = 'public' and p.proname like 'push\_%'),
            '10'
     union all
     select 7, 'push functions anon can execute',
            (select count(*)::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace
              where s.nspname = 'public' and p.proname like 'push\_%' and has_function_privilege('anon', p.oid, 'execute')),
            '0'
     union all
     select 8, 'push functions authenticated can execute',
            (select count(*)::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace
              where s.nspname = 'public' and p.proname like 'push\_%' and has_function_privilege('authenticated', p.oid, 'execute')),
            '0'
     union all
     select 9, 'of push_create, push_update, push_delete, push_targets, push_drop, push_vapid_get and push_vapid_put, how many service_role can execute',
            (select count(*)::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace
              where s.nspname = 'public'
                and p.proname in ('push_create', 'push_update', 'push_delete', 'push_targets', 'push_drop', 'push_vapid_get', 'push_vapid_put')
                and has_function_privilege('service_role', p.oid, 'execute')),
            '7'
     union all
     select 10, 'cron job purge-push-subscriptions',
            (select coalesce(string_agg(schedule || case when active then ' (active)' else ' (not active)' end, ', '), 'missing')
               from cron.job where jobname = 'purge-push-subscriptions'),
            '17 4 * * * (active)'
     union all
     select 11, 'push_cell(39.952, -75.164)', public.push_cell(39.952, -75.164)::text, '129944032'
     union all
     select 12, 'RLS is on for push_vapid_tokens',
            (select relrowsecurity::text from pg_class where oid = 'public.push_vapid_tokens'::regclass),
            'true'
     union all
     select 13, 'row policies on push_vapid_tokens',
            (select count(*)::text from pg_policies where schemaname = 'public' and tablename = 'push_vapid_tokens'),
            '0'
     union all
     select 14, 'anon has a table privilege on push_vapid_tokens',
            has_table_privilege('anon', 'public.push_vapid_tokens', 'select,insert,update,delete,truncate,references,trigger')::text,
            'false'
     union all
     select 15, 'authenticated has a table privilege on push_vapid_tokens',
            has_table_privilege('authenticated', 'public.push_vapid_tokens', 'select,insert,update,delete,truncate,references,trigger')::text,
            'false'
     union all
     select 16, 'anon or authenticated has a column privilege on push_vapid_tokens',
            (has_any_column_privilege('anon', 'public.push_vapid_tokens', 'select,insert,update,references')
             or has_any_column_privilege('authenticated', 'public.push_vapid_tokens', 'select,insert,update,references'))::text,
            'false'
   ) as checks
   order by n;
   ```

   It returns 16 rows, and the `ok` column of every row should be `true`. If any row says `false`, stop: don't deploy the sender or turn on alerts until it is fixed (ask the backend owner, or re-run the migration, which is safe to run twice). What each row should show:

   | Row | Should be | What it proves |
   | --- | --- | --- |
   | 1 | `true` | Row-level security is on for `push_subscriptions` |
   | 2 | `0` | There are no row policies, so with RLS on the browser roles can read or write no row |
   | 3, 4 | `false` | `anon` and `authenticated` have no privilege on the table (no select, insert, update, delete, truncate, references or trigger) |
   | 5 | `false` | ...and none on any single column of it |
   | 6 | `10` | The push functions are all there: `push_cell`, `push_clean_cells`, `push_create`, `push_update`, `push_delete`, `push_targets`, `push_drop`, `push_vapid_get`, `push_vapid_put` and `push_purge` (a later handoff that adds one makes this number go up: expected then) |
   | 7, 8 | `0` | Neither `anon` nor `authenticated` can run any push function |
   | 9 | `7` | `service_role`, which the secret key uses, can run the seven it needs: `push_create`, `push_update`, `push_delete`, `push_targets`, `push_drop`, `push_vapid_get` and `push_vapid_put` |
   | 10 | `17 4 * * * (active)` | The daily cleanup job exists, runs at 04:17 UTC and is on (`missing` or `(not active)` means it didn't get scheduled: see step 3) |
   | 11 | `129944032` | The square for (39.952, −75.164) is the one `lib/push-cells.ts` gives |
   | 12 | `true` | Row-level security is on for `push_vapid_tokens` |
   | 13 | `0` | There are no row policies on it, so with RLS on the browser roles can read or write no token |
   | 14, 15 | `false` | `anon` and `authenticated` have no privilege on `push_vapid_tokens` (no select, insert, update, delete, truncate, references or trigger) |
   | 16 | `false` | ...and none on any single column of it |

   `service_role` may also be able to run `push_cell`, `push_clean_cells` and `push_purge`, because Supabase gives it new functions by default. That is harmless (the secret key skips every rule anyway) and isn't checked.
5. **Sender.** Deploy the `push-sightings` Edge Function and create its webhook: see "The sender" below.

### The sender: the `push-sightings` Edge Function

`supabase/functions/push-sightings/index.ts` sends the alerts, and `webpush.ts` beside it encrypts each message and signs the VAPID tokens with the runtime's built-in WebCrypto (no package is used). A database webhook calls the function after every new pin. It checks the secret header, answers `ok` at once, and then, in the background, asks `push_targets` for the first 200 subscriptions whose squares hold the pin's square. For each one it first checks the endpoint against the same list of push services as the table and `app/actions/push.ts` (a mismatch counts as failed and is never contacted), then encrypts the message for that subscription (`aes128gcm`, RFC 8291, one record padded as RFC 8188 describes to a fixed size, so every body is 1,126 octets whatever the text), adds the VAPID token for that push service (RFC 8292, ES256; see below) and sends it (TTL 1 hour, urgency high, no topic, 20 at a time). The function deletes the subscriptions whose push service answers 404 or 410 with `push_drop`. If the page was full, it calls itself for the next 200 (see "The follow-on call" below). A 429, a 5xx answer or a network error on a push is retried twice, after the `Retry-After` wait (at most 10 s) or else 2 s and then 6 s. No push request starts more than 100 s into a call, and a message that still fails is dropped, not kept. A push that would start after 100 s counts as failed at once, with no token read, signed or stored for it. If a push started just before 100 s, its token read may finish after it: the push isn't sent, but a token signed then is still stored for later calls. Everyone gets the same message: `{ "v": 1, "id", "lat", "lng", "cat", "at", "pad" }`, the pin's rounded point, category, time and id, padded with spaces to exactly 512 characters.

**One token per push service, shared.** Apple asks senders not to refresh the token more than once an hour, but a function worker on the Free plan lives at most 150 s, so a token kept in a worker's memory would be signed again for nearly every pin. So the token for each push service's origin is kept in `push_vapid_tokens` and shared by every worker. In each call, the first push to an origin reads the stored token with `push_vapid_get`, with the secret key in `apikey` only, as for `push_targets`. Every other push to that origin in the call waits for the same answer, so a call reads at most once and signs at most once per origin. Only when no stored token is usable (none is stored, it has under 15 minutes left, or it was signed with another key or subject) does the call sign a new one for 12 hours, store it with `push_vapid_put` without waiting, and use it. The sender checks a stored token again before using it: its form, key, push service, subject and expiry (not its signature). The call ends only after its token writes have finished, but a write never delays a push. Two workers at the same moment may each sign one; the last write stays. If the read or the write fails (an error, a timeout, or an answer that isn't a usable token), the call signs its own token and sends anyway: an alert matters more than the hourly guidance. Nothing about the token is logged. Only the origin of an endpoint that passed the check above ever reaches the table.

**The follow-on call.** The call for the next page is tried once more only when it never ran: after a 429 (waiting for its `Retry-After`, at most 10 s, or else 2 s), or when Supabase's runtime throws its rate-limit error for function-to-function calls (`Deno.errors.RateLimitError`; waiting the `retryAfterMs` it gives, at most 10 s, or else 2 s when it gives none). Any other failure is not retried, including a 5xx answer, another 4xx, a network error or a timeout: a call that had started would send its page a second time, and iPhones show a repeat as a second notification (WebKit bug 258922). No retry starts 100 s or more into the call.

It writes one log line per call, `{"event":"push-sightings","sent":n,"dropped":n,"failed":n,"next":true|false}`, and two error lines: `{"event":"push-sightings","error":"not_configured"}` (a secret is missing or malformed) and `{"event":"push-sightings","error":"unexpected"}` (anything else went wrong; it holds no detail on purpose, because errors from `fetch` contain the push endpoint). It never logs or returns an endpoint, key, coordinate, pin id or anything a push service said, and its answer is always one word: `ok`, `ignored`, `unauthorized` or `error`.

Do these on your own computer, in the real project only. The Supabase CLI runs with `npx supabase …` (version 3.x was checked; `npx supabase --help` and `npx supabase functions deploy --help` list the current flags).

1. **Log in and link.** `npx supabase login`, then `npx supabase link --project-ref <project-ref>` (the ref is in the project's URL and under Project Settings). Linking creates a `supabase/.temp` folder: don't commit it.
2. **Secrets.** Set these three as Edge Function secrets, in Dashboard → Edge Functions → Secrets (best for the key: it stays out of your shell history), or with `npx supabase secrets set NAME=value`:

   | Secret | Value |
   | --- | --- |
   | `VAPID_PRIVATE_JWK` | The private key (JSON) from "VAPID keys" in step 1 above, pasted as one line. It must be the pair of `NEXT_PUBLIC_VAPID_PUBLIC_KEY`: a phone accepts alerts only from the key it subscribed with. Never put it in the repository or Vercel |
   | `VAPID_SUBJECT` | A contact for the push services: `mailto:name@example.org` or `https://example.org`, with no spaces or angle brackets (Apple refuses other forms), in plain ASCII (percent-encode anything else) and at most 512 characters, so `push_vapid_tokens` can store it. Otherwise the function answers `error` and logs `not_configured`. Google, Apple, Mozilla and Microsoft can see it, so use an address that isn't personal |
   | `PUSH_WEBHOOK_SECRET` | A long random value, for example from `openssl rand -base64 32`. Keep it: the webhook needs the same value |

   You don't set the project URL or the secret key: Supabase gives every function `SUPABASE_URL` and `SUPABASE_SECRET_KEYS` (a JSON list of the project's secret API keys; the function uses the one named `default`). If the function logs `not_configured`, check these three secrets first, then that the project has a secret API key. A private key whose `x` and `y` don't belong to its `d` is refused, and every push then counts as failed. A new value applies at once, with no redeploy. To use `--env-file` instead, keep the file outside the repository and delete it afterwards.
3. **Deploy, with JWT verification off.** From the repository root: `npx supabase functions deploy push-sightings --no-verify-jwt --use-api` (`--use-api` bundles on Supabase's side, so Docker isn't needed). Supabase otherwise refuses calls that carry no Supabase login token, and the webhook sends none: the secret header is this function's check. Pass `--no-verify-jwt` on every deploy; a deploy without it turns verification back on. The function should then appear in Dashboard → Edge Functions.
4. **Test call.** This sends a made-up pin straight to the function and inserts nothing into `sightings`, but it does send real pushes to every phone watching that square, so use a point near a test place that only your own test phone has switched on. The test phone shows every push it gets:

   ```bash
   read -rs PUSH_WEBHOOK_SECRET   # paste the secret; it won't show or enter your history
   curl -i -X POST "https://<project-ref>.supabase.co/functions/v1/push-sightings" \
     -H "content-type: application/json" \
     -H "x-icepik-webhook: $PUSH_WEBHOOK_SECRET" \
     -d '{"type":"INSERT","table":"sightings","record":{"id":"00000000-0000-4000-8000-000000000001","lat":39.952,"lng":-75.164,"category":"other","created_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}}'
   ```

   Expect `200` and the body `ok`, an alert on the test phone within seconds, and in Dashboard → Edge Functions → push-sightings → Logs one line such as `{"event":"push-sightings","sent":1,"dropped":0,"failed":0,"next":false}`. With a wrong or missing `x-icepik-webhook` header the answer is `401` and `unauthorized`, and nothing is sent. A made-up pin that is valid but matches no phone logs `"sent":0`. Try an iPhone with the app on the Home Screen first: the encryption and the signing follow RFC 8291 and RFC 8292 and reproduce the RFC's own worked example, but they haven't met a real push service yet.
5. **Create the webhook, real project only** (never the demo or a scratch project: it would send pushes for their pins too). Dashboard → Database → Webhooks → Create a new hook:
   - Name `push_sightings`; Table `public.sightings`; Events: **Insert** only.
   - Type of webhook: **Supabase Edge Functions** and pick `push-sightings` (or **HTTP Request** with method `POST` and the URL `https://<project-ref>.supabase.co/functions/v1/push-sightings`).
   - HTTP Headers: keep `Content-Type: application/json` and add `x-icepik-webhook` with the same value as `PUSH_WEBHOOK_SECRET`. Don't add the "auth header with service key" option: the function doesn't need it, and it would send the secret key to it. The webhook stores the header value in its trigger, visible to anyone with database access.
   - Timeout: the default is 1000 ms. Raise it to 5000 ms: the function answers at once, but a cold start can take longer than a second, and a webhook that times out is not retried.

   Then post a pin from a second phone, or run the "Test pins" SQL above (delete it afterwards), and check the function's Logs. `pg_net` keeps each answer for 6 hours in `net._http_response`; the function's are one word.

What to know:

- **Free plan.** A call may use 2 s of CPU and 150 s of wall time ([limits](https://supabase.com/docs/guides/functions/limits)), and the plan gives 500,000 calls a month. In the local test one message cost about 1.5 to 1.6 ms of CPU (encrypting it, with the token already signed, 1.0 to 1.1 ms), so a 200-subscriber page takes roughly 0.3 s. A call signs at most one token per push service. A pin costs one call plus one more for every further 200 subscribers.
- **Long chains.** Supabase's limits page lists "Recursive/Nested Function Calling: 30 requests per trace, within a 60-second window" ([limits](https://supabase.com/docs/guides/functions/limits), [recursive calls](https://supabase.com/docs/guides/functions/recursive-functions)). If that applies to the function calling itself, alerts for one pin would stop after about 6,000 subscribers. Watch this if the number of subscriptions grows. Over that limit, Supabase's runtime throws its rate-limit error, and the follow-on call is tried once more after the wait the error gives (at most 10 s, or 2 s when it gives none); that retry may count toward the same 30.
- **No second chances.** A follow-on call is tried once more only after a 429 or Supabase's rate-limit error, which both mean it never ran. After any other failure, or if that one retry fails too, the rest of that pin's subscribers may get no alert: a call that may have run is never repeated, because the phones on its page would get the alert twice. A push that still fails after its retries is dropped.
- **Rotating the VAPID key** makes every saved subscription useless, since phones accept only the key they subscribed with: they have to subscribe again. Stored tokens of the old key are ignored (`push_vapid_get` matches the public key) and replaced on first use. A new `VAPID_SUBJECT` works the same way.
- **A bad stored token.** The sender doesn't check a stored token's signature. Only the secret key or the database's owner can write one, but if a token that looks right yet fails at a push service got in, pushes to that service would fail until it has under 15 minutes left (at most 24 hours). To clear the tokens, run `delete from public.push_vapid_tokens;` in the SQL Editor: the next call signs new ones.

## Done when

Run these on two real phones (A and B) against the Supabase project before calling the frontend done.

- [ ] A first visit shows the terms, and nothing loads from Supabase, CARTO or the CAPTCHA provider until the user agrees. Then the map opens with no sign-up screen and shows the test pins.
- [ ] A pin posted on phone A appears on phone B within a few seconds, without a refresh.
- [ ] Phone B confirms A's pin from within 1 km, and both phones show the new count and status.
- [ ] A vote from more than 1 km away shows the server's message.
- [ ] Phone A sees Delete and no vote buttons on its own pin; deleting it removes the pin from phone B.
- [ ] A pin disappears from both maps within a minute of its `expires_at`.
- [ ] The 6th post in one clock hour shows the posting-limit message and keeps the form filled in.
- [ ] Closing and reopening the app keeps the same account and its "my posts".
- [ ] Saving a username on phone A, then logging in on phone B, shows the same profile totals. A username such as maria.lopez or jo is refused before it's sent.
- [ ] Deleting a saved account asks for its password first. Deleting any account signs the phone out and leaves its pins on the map.
- [ ] A network inspector shows the device's location only in the `voteOnSighting` server action request, saved places never, and no request URL holding a pin id, user id or coordinates. No request from the browser to Supabase posts, votes on or deletes a pin.
- [ ] Searching the browser bundle (.next/static) finds neither the secret key's value (search for its first 20 characters; supabase-js itself mentions the sb\_secret\_ prefix, which is fine) nor the name SUPABASE\_SECRET\_KEY, and only app/actions/recovery.ts imports lib/supabase/admin.ts.
- [ ] Calling each server action directly with missing, wrong-type or oversized arguments returns a message and writes nothing, and rapid repeat calls get rate-limited by Vercel's firewall.
- [ ] Saving an account on phone A shows a recovery key once. Making a new key in Settings asks for the password and replaces the key, and the old key then fails.
- [ ] "Forgot password?" with the right key sets the new password, signs phone B out (when it next calls getUser(), and within an hour at most), and shows a new key; the used key no longer works.
- [ ] A wrong key and an unknown username get exactly the same message.
- [ ] Changing the password in Settings fails without the current password, and Supabase never sends an email (the hook refuses it).
- [ ] `scripts/supabase-live-checks.mjs` passes against a scratch Supabase project set up like production.

## Not built yet and known gaps

These are outside the MVP schema. Ask before building screens that need them.

- **Push alerts: built, not yet tried on real phones.** The tables, functions, cleanup job, server actions, renew route and sender (see "Push alerts" above), and the phone side ("In the app": service worker, Settings → Alerts, subscribe flow, upkeep, policy text) are built and checked against stand-ins. The policy's `POLICY_VERSION` is a draft. The owner approved the policy wording on 28 November 2026; `POLICY_VERSION` stays marked draft until the owner says to mark it final. Still to do: the owner's device check on a preview deployment (iPhone Home Screen app and Android).
- **Stretch features with no tables yet:** local news, live streaming and translated text. Only `preferred_language` is stored. Light mode needs nothing from the database.
- **Out of scope in the PRD:** comments and followers.
- **No moderation:** there's no "report this pin" flow. For now, admins delete harmful posts in Supabase's Table Editor. A report button needs a new table, so ask first.
- **Run the live checks before upgrading the live project.** The database was tested on a local copy, not on Supabase itself. `scripts/supabase-live-checks.mjs` runs against a scratch Supabase project set up like production (its header lists the settings) and checks what this design depends on: CAPTCHA and "Require current password" really on, anonymous sign-in with the new trigger on `auth.users`, saving an anonymous account, the `amr` claim after a sign-in and after a refresh, that a reset ends every session and that the old tokens of those sessions can't make a key or delete the account, that Supabase's own "forgot password" is refused by the hook and stores no code, and the delete rules. Supabase Auth's source already shows two of these: the current-password check applies only to users who already have a password (`internal/api/user.go`), and an admin password change logs out every session (`internal/api/admin.go` calls `UpdatePassword` with no session, which runs `Logout`). The hourly cleanup job also hasn't run on Supabase yet.
- **Supabase's own logs** record each request's IP address, a rough location worked out from it, the full URL and the user id from the session token. They're kept about 1 day on the Free plan and 7 days on Pro, and Pro's daily backups keep deleted rows for 7 days. Server actions hide the user's IP but not their user id, so while logs are kept they can match a user's posts and votes to their browser requests, which carry their IP, and a post's time to its public `created_at`. For each session, Supabase Auth also keeps in `auth.sessions` the IP address and browser of its last token refresh (about hourly while the app is open), until that session ends: a sign-out on that device, a password reset or deleting the account. A sign-in on a device that already has a session leaves the earlier one behind, which is why the save, "make a new recovery key" and delete flows end it. That can't be turned off; Supabase's session time-box and inactivity timeout settings, where the plan offers them, would remove stale rows. Vercel also sees every visitor's IP. With CAPTCHA required, Cloudflare's Turnstile sees each visitor's IP address, browser and TLS fingerprint when an account is created, and whenever someone opens Log in, Save account, Forgot password or Make a new recovery key, or, for a saved account, Delete my account; its privacy notice gives no retention period. A subpoena or warrant can demand all of it, so tell users plainly what is kept instead of promising complete anonymity. CARTO's tile servers and its delivery network (Fastly) also see each visitor's IP and the area they view. Fastly keeps full client IPs for up to two business days (seven when tied to transmission errors, at least a year when tied to activity it flags as suspicious). CARTO shortens IP addresses before logging them and keeps those logs for 30 days in the US. Its terms forbid proxying its tiles, so hiding visitors' IPs from the tile server would mean hosting your own tiles, which isn't decided yet.
- **Anyone can check whether a username exists.** Supabase's own password-reset endpoint answers differently for a username that has an account, and so does saving ("That username is taken"). CAPTCHA, now required, guards the reset endpoint, account creation and password sign-in. Saving has no CAPTCHA: once someone has one anonymous account, only Supabase's per-IP rate limits (Authentication → Rate Limits) slow down checks made that way, so consider lowering the limit for user updates. Tell people not to pick a username that identifies them.
- **"Verified" can be faked.** The voter's location is whatever the app sends, and anonymous accounts are free, so two throwaway accounts can verify a false pin or keep it on the map. This was true before the recovery-key changes. CAPTCHA on account creation and Supabase's per-IP limit on anonymous sign-ins are the only brakes; stronger checks, such as device attestation, would cost anonymity, so ask before adding them.
- **Unsaved accounts may end after 30 days.** Supabase's docs say anonymous users aren't cleaned up automatically, but its Auth server's source deletes anonymous users created more than 30 days ago whenever anonymous sign-ins are on (`internal/models/cleanup.go`). If hosted Supabase runs that cleanup, every unsaved account, with its totals and its posts' private links, ends a month after it was made. Ask Supabase support which is true; until then, saving the account is the way to keep it.
- **If the username trigger ever blocks Supabase Auth,** run `drop function public.check_login_id() cascade;` in the SQL Editor (Supabase refuses `drop trigger` on `auth.users`, which its Auth role owns), fix the function, and run the migration again to put the trigger back.
- **Two NIST rules ICEPik knowingly skips:** telling the user about a reset through a stored contact address (there is none; every session ends instead, so the owner notices), and disabling the recovery key after 100 failed tries (that would let anyone lock a user out, and a 128-bit key can't be guessed). Record both as deliberate exceptions.
- **Optional recovery email (not built):** the most privacy-conscious fallback for people who lose their key stores only a slow, salted fingerprint of the address. But the email provider and the user's mailbox keep plaintext records, and ICEPik could be ordered to check a known address. Ask before building it.
- **Passkeys (not built):** Supabase's are in beta, and passkeys synced through Chrome send ICEPik's domain, the username and the account id to Google.

## Sources

- [Supabase: Server-side auth for Next.js](https://supabase.com/docs/guides/auth/server-side/nextjs)
- [Supabase: Auth error codes](https://supabase.com/docs/guides/auth/debugging/error-codes)
- [Supabase: Anonymous sign-ins](https://supabase.com/docs/guides/auth/auth-anonymous)
- [Supabase: Managing user data](https://supabase.com/docs/guides/auth/managing-user-data)
- [Supabase: Log field reference](https://supabase.com/docs/guides/monitoring-and-debugging/log-field-reference.md)
- [Supabase: Auth audit logs](https://supabase.com/docs/guides/auth/audit-logs)
- [Supabase: Pricing (log and backup retention)](https://supabase.com/pricing)
- [CARTO: Basemaps API key](https://www.carto.com/basemaps/apikey/)
- [CARTO: Basemap terms (attribution, no proxying, IP truncation, log retention)](https://carto.com/legal/basemap-terms/)
- [CARTO: Subprocessors](https://carto.com/legal/subp)
- [Fastly: Data management (IP retention)](https://docs.fastly.com/products/data-management)
- [Next.js with-supabase example: server client](https://github.com/vercel/next.js/blob/canary/examples/with-supabase/lib/supabase/server.ts)
- [NIST SP 800-63B-4: Authentication and Authenticator Management](https://pages.nist.gov/800-63-4/sp800-63b.html)
- [OWASP: Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
- [Supabase discussion #29370: username + password with a fake domain](https://github.com/orgs/supabase/discussions/29370)
- [Supabase: Send Email hook](https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook)
- [Supabase: admin updateUserById](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid)
- [Supabase: Password security](https://supabase.com/docs/guides/auth/password-security)
- [Supabase: Anonymous sign-ins, automatic cleanup](https://supabase.com/docs/guides/auth/auth-anonymous)
- [supabase/auth: cleanup of anonymous users (internal/models/cleanup.go)](https://github.com/supabase/auth/blob/master/internal/models/cleanup.go)
- [Cloudflare: Turnstile privacy notice](https://www.cloudflare.com/turnstile-privacy-policy/)
- [supabase/auth: user update and the current-password check (internal/api/user.go)](https://github.com/supabase/auth/blob/master/internal/api/user.go)
- [supabase/auth: admin user update (internal/api/admin.go)](https://github.com/supabase/auth/blob/master/internal/api/admin.go)
- [Cloudflare Turnstile: test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
- [Cloudflare Turnstile: server-side validation (siteverify)](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Supabase: Cron quickstart (cron.schedule)](https://supabase.com/docs/guides/cron/quickstart)
- [Vercel: Config and Secret environment variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables)
- [Vercel: Managing environment variables](https://vercel.com/docs/environment-variables/managing-environment-variables)
- [RFC 8188: Encrypted Content-Encoding for HTTP](https://www.rfc-editor.org/rfc/rfc8188)
- [RFC 8291: Message Encryption for Web Push (its section 5 is the worked example)](https://www.rfc-editor.org/rfc/rfc8291)
- [RFC 8292: VAPID for Web Push](https://www.rfc-editor.org/rfc/rfc8292)
- [Supabase: Recursive / nested function calls](https://supabase.com/docs/guides/functions/recursive-functions)
- [Supabase: Edge Function limits (150 s wall clock on the Free plan, 2 s of CPU)](https://supabase.com/docs/guides/functions/limits)
- [Apple: Sending web push notifications in web apps and browsers (no invisible pushes, no JWT refresh more than once an hour, subscribe from the gesture's handler)](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
- [WebKit bug 258922: push notifications with the same tag don't replace each other](https://bugs.webkit.org/show_bug.cgi?id=258922)
- [Pushpad: what are the browser push services?](https://pushpad.xyz/blog/what-are-the-browser-push-services)
