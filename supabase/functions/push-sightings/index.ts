// Sends a Web Push alert for each new sighting to every subscription whose
// ~2.2 km squares hold the sighting. Runs as a Supabase Edge Function (Deno).
//
// Called two ways, both with the secret header x-icepik-webhook:
//   1. The database webhook on public.sightings INSERT: { type, table, record }.
//   2. This function calling itself for the next page of subscriptions:
//      { next: { sighting, after } }.
//
// VAPID tokens are shared through the database, one per push service, because
// a worker lives at most 150 s and Apple asks senders not to make a new token
// more than once an hour. A call reads the stored token once per push service
// (push_vapid_get), and signs and stores a new one (push_vapid_put) only when
// none is usable. If the read or the write fails, the call signs its own token
// and sends anyway: an alert matters more than the hourly guidance.
//
// Rules for this file:
// - Log only the fixed lines in logSummary() and logError(). Never log an
//   endpoint, key, coordinate, id, error object or error message: Deno's fetch
//   errors contain the URL.
// - Never read, return or log what a push service answers. Only its status
//   code is used.
// - Messages are encrypted and signed in ./webpush.ts with WebCrypto only: no
//   package is imported.
// - Every response body is one of: ok, ignored, unauthorized, error.
// - JWT verification is off for this function (see docs/database-handoff.md);
//   the secret header is its only check.

import { encrypt, fromBase64Url, signVapid, vapidHeaderUsable, vapidPublicKey } from "./webpush.ts";

const NAME = "push-sightings";
const SECRET_HEADER = "x-icepik-webhook";

const PAGE_SIZE = 200; // subscriptions per call
const IN_FLIGHT = 20; // push requests at once
const TTL_SECONDS = 3600;
const PAYLOAD_CHARS = 512; // JSON.stringify(payload).length, space-padded
const PADDED_BYTES = 1024; // every record is padded (RFC 8188) to this size before encryption
const GIVE_UP_MS = 100_000; // start no push request later than this into a call
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_WAIT_MS = 10_000;
const RETRY_WAITS_MS = [2_000, 6_000]; // two retries after the first try

const CATEGORIES = new Set(["patrol", "vehicle", "checkpoint", "raid", "other"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The push services of Chrome (FCM, and Google's jmt17 host), Apple, Mozilla
// and Microsoft: the same list as ENDPOINT in app/actions/push.ts and the
// table's check in database/icepik_schema.sql. Keep the three in step. Checked
// again here so this function can never be aimed at another URL.
const ENDPOINT =
  /^https:\/\/(fcm\.googleapis\.com|jmt17\.google\.com|web\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)\/[\x21-\x7e]*$/;
const MAX_ENDPOINT_LENGTH = 1024;
const MAX_SUBJECT_CHARS = 512; // push_vapid_tokens.subject's limit

// Exists only on Supabase's runtime.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

type Word = "ok" | "ignored" | "unauthorized" | "error";

type Config = {
  url: string; // project URL, no trailing slash
  key: string; // secret API key (sb_secret_…)
  jwk: JsonWebKey; // VAPID private key
  subject: string; // mailto: or https: contact
  secret: string; // expected x-icepik-webhook value
};

type Sighting = { id: string; lat: number; lng: number; category: string; at: string };
type Job = { sighting: Sighting; after: string | null };
type Target = { id: string; endpoint: string; p256dh: string; auth: string };
type Outcome = "sent" | "gone" | "failed";
// One call's VAPID headers by push-service origin, and its token writes.
type Tokens = { headers: Map<string, Promise<string>>; writes: Promise<unknown>[] };

// ---------------------------------------------------------------- logging

function logSummary(sent: number, dropped: number, failed: number, next: boolean) {
  console.log(JSON.stringify({ event: NAME, sent, dropped, failed, next }));
}

function logError(error: "unexpected" | "not_configured") {
  console.error(JSON.stringify({ event: NAME, error }));
}

// A stray rejection would otherwise be printed by the runtime, message and all.
globalThis.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  logError("unexpected");
});

// ---------------------------------------------------------------- entry

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    return await handle(req);
  } catch {
    logError("unexpected");
    return reply(500, "error");
  }
});

function reply(status: number, word: Word): Response {
  return new Response(word, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handle(req: Request): Promise<Response> {
  const startedAt = Date.now();
  if (req.method !== "POST") return reply(405, "error");

  const config = readConfig();
  if (!config) {
    logError("not_configured");
    return reply(500, "error");
  }

  if (!(await secretMatches(req.headers.get(SECRET_HEADER), config.secret))) {
    return reply(401, "unauthorized");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return reply(200, "ignored");
  }
  const job = parseJob(body);
  if (!job) return reply(200, "ignored");

  // Answer at once: a database webhook waits only briefly. The sending carries
  // on in the background, which Supabase keeps alive until it finishes.
  background(runJob(config, job, startedAt));
  return reply(200, "ok");
}

function background(task: Promise<unknown>) {
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(task);
}

// ---------------------------------------------------------------- config and auth

function readConfig(): Config | null {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS"); // JSON: { default: "sb_secret_…" }
    const jwkText = Deno.env.get("VAPID_PRIVATE_JWK");
    const subject = Deno.env.get("VAPID_SUBJECT");
    const secret = Deno.env.get("PUSH_WEBHOOK_SECRET");
    if (!url || !secretKeys || !jwkText || !subject || !secret) return null;

    // Apple refuses a VAPID subject that isn't a mailto: or https: URL. Only
    // printable ASCII (a URL's own characters) and at most 512 characters, so
    // push_vapid_tokens can store the subject and the tokens that name it.
    if (subject.length > MAX_SUBJECT_CHARS || !/^(mailto:|https:\/\/)[\x21-\x7e]+$/.test(subject)) return null;
    if (/[<>]/.test(subject)) return null;

    const keys = JSON.parse(secretKeys);
    const key = isRecord(keys)
      ? (typeof keys.default === "string" ? keys.default : Object.values(keys).find((v) => typeof v === "string"))
      : undefined;
    if (typeof key !== "string" || key.length === 0) return null;

    const jwk = JSON.parse(jwkText); // once per call
    if (!isRecord(jwk) || jwk.kty !== "EC" || typeof jwk.d !== "string") return null;
    if (typeof jwk.x !== "string" || typeof jwk.y !== "string") return null;

    return {
      url: new URL(url).origin,
      key,
      jwk: jwk as JsonWebKey,
      subject,
      secret,
    };
  } catch {
    return null;
  }
}

// Compares SHA-256 digests, so the time taken doesn't depend on where the
// two values first differ.
async function secretMatches(given: string | null, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(given ?? ""), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// ---------------------------------------------------------------- input checks

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJob(body: unknown): Job | null {
  if (!isRecord(body)) return null;

  if ("next" in body) {
    const next = body.next;
    if (!isRecord(next)) return null;
    const sighting = parseSighting(next.sighting);
    if (!sighting || typeof next.after !== "string" || !UUID.test(next.after)) return null;
    return { sighting, after: next.after.toLowerCase() };
  }

  if (body.type !== "INSERT" || body.table !== "sightings") return null;
  const sighting = parseSighting(body.record);
  return sighting ? { sighting, after: null } : null;
}

// Keeps only the five fields we use; everything else in the record is ignored.
function parseSighting(record: unknown): Sighting | null {
  if (!isRecord(record)) return null;
  const { id, lat, lng, category, created_at } = record;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (!inRange(lat, -90, 90) || !inRange(lng, -180, 180)) return null;
  if (typeof category !== "string" || !CATEGORIES.has(category)) return null;
  if (typeof created_at !== "string") return null;
  const time = Date.parse(created_at);
  if (!Number.isFinite(time)) return null;
  return {
    id: id.toLowerCase(),
    lat: round3(lat),
    lng: round3(lng),
    category,
    at: new Date(time).toISOString(),
  };
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------- one page

// Never rejects: anything unexpected becomes the one error line.
async function runJob(config: Config, job: Job, startedAt: number): Promise<void> {
  const tokens: Tokens = { headers: new Map(), writes: [] };
  try {
    const plaintext = buildPayload(job.sighting);

    const targets = await fetchTargets(config, job);
    if (!targets) throw new Error("targets");

    // A full page means there may be more: have this function fetch the next
    // one in its own call, and don't wait for it.
    const full = targets.length === PAGE_SIZE;
    if (full) {
      const last = targets[targets.length - 1];
      if (!isRecord(last) || typeof last.id !== "string" || !UUID.test(last.id)) throw new Error("page");
      startNext(config, job.sighting, last.id, startedAt);
    }

    const usable: Target[] = [];
    let failed = 0;
    for (const row of targets) {
      if (
        isRecord(row) && typeof row.id === "string" && UUID.test(row.id) &&
        typeof row.endpoint === "string" && typeof row.p256dh === "string" && typeof row.auth === "string"
      ) {
        usable.push({ id: row.id, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth });
      } else {
        failed++;
      }
    }

    let sent = 0;
    const gone: string[] = [];
    await inParallel(usable, IN_FLIGHT, async (target) => {
      const outcome = await deliver(config, tokens, plaintext, target, startedAt);
      if (outcome === "sent") sent++;
      else if (outcome === "gone") gone.push(target.id);
      else failed++;
    });

    let dropped = 0;
    if (gone.length > 0) {
      const result = await rpc(config, "push_drop", { p_ids: gone });
      if (result.ok) dropped = gone.length;
      else failed += gone.length;
    }

    // The call lasts until its token writes have finished. They never delay
    // a push, and their outcome is not logged.
    await Promise.allSettled(tokens.writes);
    logSummary(sent, dropped, failed, full);
  } catch {
    await Promise.allSettled(tokens.writes);
    logError("unexpected");
  }
}

// The same text for everyone: the rounded point, category, time and sighting
// id, padded with spaces to a fixed length so its size reveals nothing.
// The phone's service worker reads these exact names. Returns its UTF-8 bytes.
function buildPayload(sighting: Sighting): Uint8Array<ArrayBuffer> {
  const payload = {
    v: 1,
    id: sighting.id,
    lat: sighting.lat,
    lng: sighting.lng,
    cat: sighting.category,
    at: sighting.at,
    pad: "",
  };
  const room = PAYLOAD_CHARS - JSON.stringify(payload).length;
  if (room < 0) throw new Error("payload");
  payload.pad = " ".repeat(room);
  const json = JSON.stringify(payload);
  if (json.length !== PAYLOAD_CHARS) throw new Error("payload");
  return new TextEncoder().encode(json);
}

async function fetchTargets(config: Config, job: Job): Promise<unknown[] | null> {
  const result = await rpc(config, "push_targets", {
    p_lat: job.sighting.lat,
    p_lng: job.sighting.lng,
    p_after: job.after,
    p_limit: PAGE_SIZE,
  });
  return result.ok && Array.isArray(result.data) ? result.data : null;
}

// Starts this function again for the page after `after`. The call is tried
// once more only when it never ran: after a 429 (wait for Retry-After, at most
// 10 s, else 2 s), or when fetch throws the error Supabase's runtime throws
// when function-to-function calls go over its limit (wait its retryAfterMs,
// at most 10 s, else 2 s). Any other failure is not retried: a call that had
// started would send its page twice, and iPhones show a repeat as a second
// notification (WebKit bug 258922). No retry starts 100 s or more into this
// call.
function startNext(config: Config, sighting: Sighting, after: string, startedAt: number) {
  const body = JSON.stringify({
    next: {
      sighting: {
        id: sighting.id,
        lat: sighting.lat,
        lng: sighting.lng,
        category: sighting.category,
        created_at: sighting.at,
      },
      after,
    },
  });
  background((async () => {
    const wait = await callNext(config, body);
    if (wait === null || Date.now() - startedAt >= GIVE_UP_MS) return;
    await sleep(wait);
    if (Date.now() - startedAt >= GIVE_UP_MS) return;
    await callNext(config, body);
  })());
}

// Makes the follow-on call once. Never throws. Returns the wait before the one
// more try when the call never ran, or null: done, or it may have run.
async function callNext(config: Config, body: string): Promise<number | null> {
  try {
    const res = await fetch(`${config.url}/functions/v1/${NAME}`, {
      method: "POST",
      headers: { "content-type": "application/json", [SECRET_HEADER]: config.secret },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const status = res.status;
    const retryAfter = res.headers.get("retry-after");
    await res.body?.cancel().catch(() => {});
    // A 429 is refused before the function runs. Any other answer, a 5xx
    // too, may come after the call had started.
    return status === 429 ? retryDelayMs(retryAfter, 0) : null;
  } catch (error) {
    // Never logged: the message holds the URL. Only the wait is read from it.
    // A network error or a timeout may come after the call had started.
    return rateLimitWaitMs(error);
  }
}

// The wait on Supabase's rate-limit error, or null for any other error. The
// runtime throws Deno.errors.RateLimitError, whose retryAfterMs is null when
// it can't tell when the limit resets: then wait 2 s. Otherwise wait the
// finite retryAfterMs, at most 10 s. Never throws.
function rateLimitWaitMs(error: unknown): number | null {
  try {
    const ms = (error as { retryAfterMs?: unknown } | null | undefined)?.retryAfterMs;
    if (typeof ms === "number" && Number.isFinite(ms)) return Math.min(Math.max(ms, 0), MAX_RETRY_WAIT_MS);
    const RateLimitError = (Deno.errors as unknown as Record<string, unknown>).RateLimitError;
    if (typeof RateLimitError === "function" && error instanceof (RateLimitError as new () => Error)) {
      return RETRY_WAITS_MS[0];
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- sending

// Never throws.
async function deliver(
  config: Config,
  tokens: Tokens,
  plaintext: Uint8Array<ArrayBuffer>,
  target: Target,
  startedAt: number,
): Promise<Outcome> {
  // Only the push services the table allows. A mismatch is counted as failed.
  // This comes first, so only an allowed push service's origin ever reaches
  // the token table.
  if (target.endpoint.length > MAX_ENDPOINT_LENGTH || !ENDPOINT.test(target.endpoint)) return "failed";
  // Past the give-up time this push can't be sent, so don't read, sign or
  // store a token for it either.
  if (Date.now() - startedAt >= GIVE_UP_MS) return "failed";

  let headers: Record<string, string>;
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = await encrypt({
      uaPublic: fromBase64Url(target.p256dh),
      authSecret: fromBase64Url(target.auth),
      plaintext,
      paddedBytes: PADDED_BYTES,
    });
    headers = {
      Authorization: await authorization(config, tokens, new URL(target.endpoint).origin),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(TTL_SECONDS),
      Urgency: "high", // no Topic
    };
  } catch {
    return "failed"; // bad keys (the subscription's or the VAPID key): retrying won't help
  }

  for (let attempt = 0;; attempt++) {
    // The message is only useful for a while, and a call may run 150 s.
    if (Date.now() - startedAt >= GIVE_UP_MS) return "failed";

    let status = 0; // 0 = no answer (network error or timeout)
    let retryAfter: string | null = null;
    try {
      const res = await fetch(target.endpoint, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      retryAfter = res.headers.get("retry-after");
      await res.body?.cancel().catch(() => {}); // the answer's text is never read
    } catch {
      // Not logged or rethrown: the error text holds the endpoint.
    }

    if (status >= 200 && status < 300) return "sent";
    if (status === 404 || status === 410) return "gone";
    const retryable = status === 0 || status === 429 || (status >= 500 && status < 600);
    if (!retryable || attempt >= RETRY_WAITS_MS.length) return "failed";
    await sleep(retryDelayMs(retryAfter, attempt));
  }
}

// Retry-After (seconds or an HTTP date), at most 10 s; otherwise 2 s, then 6 s.
function retryDelayMs(header: string | null, attempt: number): number {
  const fallback = RETRY_WAITS_MS[attempt];
  if (header === null) return fallback;
  const text = header.trim();
  let ms: number;
  if (/^\d+$/.test(text)) {
    ms = Number(text) * 1000;
  } else {
    const date = Date.parse(text);
    if (!Number.isFinite(date)) return fallback;
    ms = date - Date.now();
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_WAIT_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs `work` over `items` with at most `limit` in flight. `work` must not throw.
async function inParallel<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

// ---------------------------------------------------------------- VAPID tokens

// The Authorization header for one push-service origin in this call. The first
// push to an origin starts the work; every other push to it, even with 20 in
// flight, awaits the same promise, so a call reads at most once and signs at
// most once per origin.
function authorization(config: Config, tokens: Tokens, origin: string): Promise<string> {
  let header = tokens.headers.get(origin);
  if (!header) {
    header = vapidHeader(config, tokens, origin);
    tokens.headers.set(origin, header);
  }
  return header;
}

// The stored token when one is usable; otherwise a new one, stored without
// waiting (two workers at the same moment may each sign one; the last write
// stays). A failed read or write just means this call signs its own. Rejects
// only when the VAPID key can't sign: every push to this origin then fails.
// There is no give-up check here: work that began before the give-up time may
// end after it, and a token signed then is still stored for later calls.
async function vapidHeader(config: Config, tokens: Tokens, origin: string): Promise<string> {
  const publicKey = await vapidPublicKey(config.jwk);
  const lookup = { p_origin: origin, p_public_key: publicKey, p_subject: config.subject };
  const stored = await rpc(config, "push_vapid_get", lookup);
  if (stored.ok && vapidHeaderUsable(stored.data, origin, config.subject, publicKey, Date.now() / 1000)) {
    return stored.data;
  }
  const fresh = await signVapid(config.jwk, config.subject, origin);
  tokens.writes.push(rpc(config, "push_vapid_put", {
    ...lookup,
    p_header: fresh.header,
    p_expires_at: new Date(fresh.expiresAt * 1000).toISOString(),
  }));
  return fresh.header;
}

// ---------------------------------------------------------------- PostgREST

// Calls a database function over HTTP with the secret key. The new secret keys
// aren't JWTs, so they go in `apikey`, not `Authorization: Bearer`. Never
// throws. data is the parsed JSON answer: for push_vapid_get a string or null,
// for push_drop and push_vapid_put null (an empty 204, or 200 with null).
async function rpc(
  config: Config,
  fn: "push_targets" | "push_drop" | "push_vapid_get" | "push_vapid_put",
  args: Record<string, unknown>,
): Promise<{ ok: true; data: unknown } | { ok: false }> {
  try {
    const res = await fetch(`${config.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: config.key, "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false };
    }
    const text = await res.text();
    return { ok: true, data: text ? JSON.parse(text) : null };
  } catch {
    return { ok: false };
  }
}
