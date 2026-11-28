"use server";

// Push alerts: a phone turns them on, renews them each time the app opens,
// changes the squares it watches, swaps its push endpoint, or turns them off.
//
// What the server keeps (public.push_subscriptions) is only the phone's push
// endpoint and keys, the ~2.2 km squares around the places it watches
// (lib/push-cells.ts), the SHA-256 of a random device secret, and two dates.
// No user id, no exact place, no time of day.
//
// Same rules as sightings.ts: anyone can call these with any input, so every
// field is checked here before it reaches the database; rows are built field
// by field; nothing is ever logged (the input holds the squares around
// someone's home, and the device secret); errors are returned as values.
//
// The database functions can be called only with the secret key, so these
// actions use createAdminClient() (lib/supabase/admin.ts), never the cookie
// client: the admin client sends no user session, so Supabase's logs can't
// tie a subscription to an account. Creating needs a Turnstile token
// (lib/turnstile.ts); updating and deleting need the device secret.
// app/api/push/renew/route.ts calls updatePushSubscription for the service
// worker, which can't call a server action.
//
// Usage from a client component:
//   const result = await createPushSubscription({ endpoint, p256dh, auth, cells, secret, captchaToken });
//   if (result.ok) keep result.data.id and the secret on the device only.

import type { PostgrestError } from "@supabase/supabase-js";
import { MAX_ALERT_CELLS } from "@/lib/push-cells";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyTurnstile } from "@/lib/turnstile";

export type PushError = "invalid" | "captcha" | "endpoint_taken" | "not_found" | "not_configured" | "failed";
export type PushResult<T> = { ok: true; data: T } | { ok: false; error: PushError; message: string };
export type PushKeys = { endpoint: string; p256dh: string; auth: string };

const MESSAGES: Record<PushError, string> = {
  invalid: "Something went wrong. Please try again.",
  captcha: "Please complete the check and try again.",
  endpoint_taken: "Alerts are already on for this browser.",
  not_found: "These alerts were turned off. Turn them on again.",
  not_configured: "Alerts aren't available on this version of the site.",
  failed: "Something went wrong. Please try again.",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 32 random bytes in base64url, without padding.
const SECRET = /^[A-Za-z0-9_-]{43}$/;
// The browser's push keys: a P-256 public key (65 bytes) and a 16-byte auth secret.
const P256DH = /^[A-Za-z0-9_-]{87}$/;
const AUTH = /^[A-Za-z0-9_-]{22}$/;
// The push services of Chrome (FCM, and Google's jmt17 host), Apple, Mozilla
// and Microsoft, as in the table's check (database/icepik_schema.sql).
const ENDPOINT =
  /^https:\/\/(fcm\.googleapis\.com|jmt17\.google\.com|web\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)\/[\x21-\x7e]*$/;
const MAX_ENDPOINT_LENGTH = 1024;
// The grid of lib/push-cells.ts: cell = row * 20000 + col, rows 0 to 9000,
// columns 0 to 13846.
const ROW = 20_000;
const LAST_ROW = 9_000;
const LAST_COL = 13_846;

export async function createPushSubscription(
  input: PushKeys & { cells: number[]; secret: string; captchaToken: string },
): Promise<PushResult<{ id: string }>> {
  if (!isRecord(input)) return failure("invalid");
  const keys = checkKeys(input);
  const cells = checkCells(input.cells);
  const captchaToken = input.captchaToken;
  if (!keys || !cells || !isSecret(input.secret) || typeof captchaToken !== "string") {
    return failure("invalid");
  }

  // Before the Turnstile check, so a token isn't used up for nothing.
  const admin = pushAdmin();
  if (!admin) return failure("not_configured");

  const captcha = await verifyTurnstile(captchaToken, "alerts");
  if (captcha !== "ok") return failure(captcha);

  const { data, error } = await admin.rpc("push_create", {
    p_endpoint: keys.endpoint,
    p_p256dh: keys.p256dh,
    p_auth: keys.auth,
    p_cells: cells,
    p_secret: input.secret,
  });
  if (error) return databaseFailure(error);
  return typeof data === "string" && UUID.test(data) ? { ok: true, data: { id: data } } : failure("failed");
}

// Always renews expiry to today + 30 days. Send cells to replace them.
// Send all of endpoint, p256dh and auth to swap the push endpoint.
export async function updatePushSubscription(
  input: { id: string; secret: string; cells?: number[] } & Partial<PushKeys>,
): Promise<PushResult<null>> {
  if (!isRecord(input) || !isId(input.id) || !isSecret(input.secret)) return failure("invalid");
  const cells = input.cells === undefined ? undefined : checkCells(input.cells);
  if (cells === null) return failure("invalid");
  const someKeys = input.endpoint !== undefined || input.p256dh !== undefined || input.auth !== undefined;
  const keys = someKeys ? checkKeys(input) : undefined;
  if (keys === null) return failure("invalid");

  const admin = pushAdmin();
  if (!admin) return failure("not_configured");

  const { data, error } = await admin.rpc("push_update", {
    p_id: input.id,
    p_secret: input.secret,
    ...(cells ? { p_cells: cells } : {}),
    ...(keys ? { p_endpoint: keys.endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth } : {}),
  });
  if (error) return databaseFailure(error);
  return data === true ? { ok: true, data: null } : failure("not_found");
}

export async function deletePushSubscription(input: { id: string; secret: string }): Promise<PushResult<null>> {
  if (!isRecord(input) || !isId(input.id) || !isSecret(input.secret)) return failure("invalid");

  const admin = pushAdmin();
  if (!admin) return failure("not_configured");

  const { data, error } = await admin.rpc("push_delete", { p_id: input.id, p_secret: input.secret });
  if (error) return databaseFailure(error);
  return data === true ? { ok: true, data: null } : failure("not_found");
}

// The real project's admin client, or null when push isn't set up here: no
// VAPID public key (the phones couldn't subscribe), or no secret key.
// Push never uses the demo project.
function pushAdmin() {
  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim()) return null;
  return createAdminClient();
}

function checkKeys(input: Record<string, unknown>): PushKeys | null {
  const { endpoint, p256dh, auth } = input;
  if (
    typeof endpoint !== "string" ||
    endpoint.length > MAX_ENDPOINT_LENGTH ||
    !ENDPOINT.test(endpoint) ||
    typeof p256dh !== "string" ||
    !P256DH.test(p256dh) ||
    typeof auth !== "string" ||
    !AUTH.test(auth)
  ) {
    return null;
  }
  return { endpoint, p256dh, auth };
}

// 1 to MAX_ALERT_CELLS squares on the grid, sorted and without repeats.
function checkCells(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ALERT_CELLS) return null;
  for (const cell of value) {
    if (!Number.isSafeInteger(cell) || cell < 0 || Math.floor(cell / ROW) > LAST_ROW || cell % ROW > LAST_COL) {
      return null;
    }
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isSecret(value: unknown): value is string {
  return typeof value === "string" && SECRET.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(error: PushError): { ok: false; error: PushError; message: string } {
  return { ok: false, error, message: MESSAGES[error] };
}

// Never passes the database's own message on, and never logs it.
function databaseFailure(error: PostgrestError) {
  if (error.message === "push_endpoint_taken") return failure("endpoint_taken");
  // push_invalid, or a table check (23514): input the checks above should
  // already have refused.
  if (error.message === "push_invalid" || error.code === "23514") return failure("invalid");
  return failure("failed");
}
