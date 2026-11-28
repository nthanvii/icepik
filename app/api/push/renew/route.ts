// POST /api/push/renew: the service worker swaps in a new push endpoint
// (after the browser's pushsubscriptionchange event). A worker can't run
// Turnstile or call a server action, so it posts here, authorised by the
// device secret, and this calls the same action the app uses, with the same
// checks (app/actions/push.ts).
//
// Body (JSON, never query parameters, so nothing lands in a request log):
//   { id, secret, endpoint, p256dh, auth }
// Answers, always with an empty body:
//   204  swapped, and renewed for 30 days
//   400  bad input, or the endpoint is another subscription's
//   403  a cross-site request, or the id or secret doesn't match
//   503  push isn't set up on this deployment, or the database failed
// Never log the request: it holds the device secret and the push endpoint.
// proxy.ts skips /api/, so this route gets no page CSP and no session refresh.

import { updatePushSubscription, type PushError } from "@/app/actions/push";

// Larger than any good body (a 1,024-character endpoint and the keys).
const MAX_BODY_BYTES = 4096;
const FIELDS = ["id", "secret", "endpoint", "p256dh", "auth"] as const;

const STATUS: Record<PushError, number> = {
  invalid: 400,
  endpoint_taken: 400,
  captcha: 403,
  not_found: 403,
  not_configured: 503,
  failed: 503,
};

export async function POST(request: Request) {
  // A browser always sends Sec-Fetch-Site; only the app's own pages and
  // service worker may post here.
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return empty(403);
  if (new URL(request.url).search !== "") return empty(400);

  const body = await readJson(request);
  if (!body) return empty(400);
  const fields: Record<string, string> = {};
  for (const name of FIELDS) {
    const value = body[name];
    if (typeof value !== "string") return empty(400);
    fields[name] = value;
  }

  const result = await updatePushSubscription({
    id: fields.id,
    secret: fields.secret,
    endpoint: fields.endpoint,
    p256dh: fields.p256dh,
    auth: fields.auth,
  });
  return empty(result.ok ? 204 : STATUS[result.error]);
}

// The body as a JSON object, or null if it isn't one or is too long.
async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function empty(status: number) {
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}
