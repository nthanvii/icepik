import "server-only";

// Checks a Cloudflare Turnstile token on the server (Cloudflare's siteverify).
// Supabase Auth checks the tokens for sign-ins with its own copy of the
// secret. This file is for ICEPik's own forms that need a check, such as
// turning on push alerts, and reads TURNSTILE_SECRET_KEY: the secret of the
// same widget, set in Vercel and never given a NEXT_PUBLIC_ name.
//
// Never log the token or Cloudflare's answer. The visitor's IP address
// (remoteip) is never sent: Cloudflare sees this server's address instead.

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
// Cloudflare's limit for a token.
const MAX_TOKEN_LENGTH = 2048;
const TIMEOUT_MS = 5000;

// "ok": the token is good for this action (or the check is off locally).
// "captcha": the token is missing, used, expired, or for another action.
// "not_configured": a Vercel deployment without TURNSTILE_SECRET_KEY.
// "failed": Cloudflare didn't answer in time.
export type TurnstileResult = "ok" | "captcha" | "not_configured" | "failed";

// True when tokens are checked. Off only on a local run (no VERCEL_ENV) with
// no secret, as in the checks against scripts/mock-supabase.mjs. Every Vercel
// deployment, previews included (they use the real database), checks or
// refuses.
export function turnstileCheckIsOn(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY?.trim()) || Boolean(process.env.VERCEL_ENV);
}

export async function verifyTurnstile(token: unknown, action: string): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return process.env.VERCEL_ENV ? "not_configured" : "ok";
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return "captcha";
  }

  try {
    const response = await fetch(SITEVERIFY, {
      method: "POST",
      body: new URLSearchParams({ secret, response: token }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return "failed";
    const result: unknown = await response.json();
    const { success, action: tokenAction } = (result ?? {}) as { success?: unknown; action?: unknown };
    return success === true && tokenAction === action ? "ok" : "captcha";
  } catch {
    // Timeout or network error. Nothing is logged: the error can hold the request.
    return "failed";
  }
}
