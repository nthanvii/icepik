// Web Push with WebCrypto only (Deno and the Supabase Edge runtime have it; no
// package): message encryption (RFC 8291 on the aes128gcm content coding of
// RFC 8188) and VAPID application server identification (RFC 8292, ES256).
//
// Rules for this file:
// - Nothing here logs. An error thrown here carries a fixed word, never an
//   endpoint, key or message from a library, and callers must not log or
//   rethrow what they catch.
// - Padding is RFC 8188's (a delimiter octet and zeros inside the record), not
//   random, so every message encrypts to a body of the same length.
// - No VAPID token is kept here, only the imported signing key. The private
//   key is used only to sign: nothing this file returns holds it.

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const text = new TextEncoder();

// WebCrypto takes buffers that are plain ArrayBuffers, not shared ones.
type Bytes = Uint8Array<ArrayBuffer>;

// ---------------------------------------------------------------- base64url

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new Error("base64");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------- aes128gcm (RFC 8188, RFC 8291)

// "rs" in the header: the record size we declare. A push service accepts a
// message of at most 4096 octets, so one record of up to 4096 fits.
export const RECORD_SIZE = 4096;
const TAG_BYTES = 16;
const HEADER_BYTES = 16 + 4 + 1 + 65; // salt, rs, idlen, keyid (the sender's public key)

export type Encryption = {
  uaPublic: Bytes; // the subscription's p256dh, 65 octets (uncompressed P-256 point)
  authSecret: Bytes; // the subscription's auth, 16 octets
  plaintext: Bytes;
  // The record holds exactly this many octets before encryption: the plaintext,
  // the delimiter 0x02 (last record), then zeros. The body is then always
  // HEADER_BYTES + paddedBytes + TAG_BYTES octets long.
  paddedBytes: number;
  // Fixed values, for the RFC's worked example only. In use both are made fresh
  // for every message.
  salt?: Bytes;
  ephemeral?: CryptoKeyPair;
};

export function bodyBytes(paddedBytes: number): number {
  return HEADER_BYTES + paddedBytes + TAG_BYTES;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8);
  return new Uint8Array(bits);
}

export async function encrypt(input: Encryption): Promise<Bytes> {
  const { uaPublic, authSecret, plaintext, paddedBytes } = input;
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04 || authSecret.length !== 16) throw new Error("keys");
  if (plaintext.length + 1 > paddedBytes || paddedBytes + TAG_BYTES > RECORD_SIZE) throw new Error("size");

  const salt = input.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error("salt");
  const ephemeral = input.ephemeral ?? await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));

  // RFC 8291 section 3.4: ecdh_secret, then the input keying material that
  // mixes in the subscription's auth secret and both public keys.
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, ECDH, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256),
  );
  const keyInfo = concat(text.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // RFC 8188 section 2.2 and 2.3: the content encryption key and nonce.
  const cek = await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12);

  // One record, the last one: plaintext, delimiter 0x02, zero padding.
  const record = new Uint8Array(paddedBytes);
  record.set(plaintext);
  record[plaintext.length] = 0x02;
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));

  // RFC 8188 section 2.1 header: salt, record size, key id length, key id.
  const header = new Uint8Array(HEADER_BYTES);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = 65;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

// ---------------------------------------------------------------- VAPID (RFC 8292)

// index.ts keeps one token per push service in the database
// (push_vapid_tokens), shared by every worker, and signs a new one with
// signVapid() only when none is usable.

const LIFETIME_S = 12 * 60 * 60; // a new token's exp is this far ahead
const MIN_LEFT_S = 15 * 60; // a stored token needs this long left: push_vapid_get's rule
const MAX_AHEAD_S = 24 * 60 * 60; // RFC 8292 section 2: exp at most 24 hours ahead
const MAX_HEADER_CHARS = 2048; // the longest header push_vapid_tokens accepts

// The JWT header segment, the same in every token.
const JWT_HEAD = toBase64Url(text.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
// "vapid t=<JWT>, k=<public key>": an ES256 signature is 64 octets (86
// characters), the public key a 65-octet point (87 characters).
const AUTHORIZATION = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{86}), k=([A-Za-z0-9_-]{87})$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

const ES256 = { name: "ECDSA", hash: "SHA-256" } as const;

type Signer = { key: CryptoKey; publicKey: string };

const signers = new Map<string, Promise<Signer>>();

// Imports the key once per isolate. Deno makes a private key from d alone and
// ignores x and y, so the public key is imported on its own and has to verify
// a signature: a JWK whose halves don't match is refused, and k= is always
// the signing key's.
function signerFor(jwk: JsonWebKey): Promise<Signer> {
  const { x, y, d } = jwk;
  if (typeof x !== "string" || typeof y !== "string" || typeof d !== "string") throw new Error("jwk");
  const id = `${x}.${y}.${d}`;
  let signer = signers.get(id);
  if (!signer) {
    signer = (async () => {
      try {
        const publicJwk = { kty: "EC", crv: "P-256", x, y, ext: true };
        const key = await crypto.subtle.importKey("jwk", { ...publicJwk, d }, ECDSA, false, ["sign"]);
        const pub = await crypto.subtle.importKey("jwk", publicJwk, ECDSA, true, ["verify"]);
        const probe = text.encode("vapid key check");
        if (!(await crypto.subtle.verify(ES256, pub, await crypto.subtle.sign(ES256, key, probe), probe))) {
          throw new Error("jwk");
        }
        const point = new Uint8Array(await crypto.subtle.exportKey("raw", pub));
        if (point.length !== 65 || point[0] !== 0x04) throw new Error("jwk");
        return { key, publicKey: toBase64Url(point) };
      } catch {
        throw new Error("jwk");
      }
    })();
    signers.set(id, signer);
  }
  return signer;
}

// The claims segment: aud, exp and sub, in that order, nothing else.
function claimsPart(origin: string, exp: number, subject: string): string {
  return toBase64Url(text.encode(JSON.stringify({ aud: origin, exp, sub: subject })));
}

// The VAPID public key: base64url of its uncompressed P-256 point (65 octets,
// 87 characters). It is the k= of every header and part of the key a token is
// stored under. Rejects with a fixed word when the JWK can't sign.
export async function vapidPublicKey(jwk: JsonWebKey): Promise<string> {
  return (await signerFor(jwk)).publicKey;
}

// A new token for one push service. origin is the push service's origin
// (https://fcm.googleapis.com, https://web.push.apple.com, ...). Returns the
// whole Authorization value and the token's exp in seconds since 1970.
// Rejects when the JWK can't sign.
export async function signVapid(
  jwk: JsonWebKey,
  subject: string,
  origin: string,
): Promise<{ header: string; expiresAt: number }> {
  const signer = await signerFor(jwk);
  const exp = Math.floor(Date.now() / 1000) + LIFETIME_S;
  const unsigned = `${JWT_HEAD}.${claimsPart(origin, exp, subject)}`;
  // WebCrypto's ECDSA signature is the raw r || s that JWS ES256 wants.
  const signature = new Uint8Array(await crypto.subtle.sign(ES256, signer.key, text.encode(unsigned)));
  return { header: `vapid t=${unsigned}.${toBase64Url(signature)}, k=${signer.publicKey}`, expiresAt: exp };
}

// Whether a stored header can be sent to this origin now: exactly the shape
// signVapid() makes, with this public key, aud and sub, and an exp at least
// 15 minutes and at most 24 hours after nowSeconds. The database already
// filters; this checks again. Never throws. The signature is not verified.
export function vapidHeaderUsable(
  header: unknown,
  origin: string,
  subject: string,
  publicKey: string,
  nowSeconds: number,
): header is string {
  try {
    if (typeof header !== "string" || header.length > MAX_HEADER_CHARS) return false;
    const match = AUTHORIZATION.exec(header);
    if (!match || match[1] !== JWT_HEAD || match[4] !== publicKey) return false;
    const claims: unknown = JSON.parse(utf8.decode(fromBase64Url(match[2])));
    const exp = typeof claims === "object" && claims !== null ? (claims as { exp?: unknown }).exp : undefined;
    if (typeof exp !== "number" || !Number.isSafeInteger(exp)) return false;
    if (match[2] !== claimsPart(origin, exp, subject)) return false;
    const left = exp - nowSeconds;
    return left >= MIN_LEFT_S && left <= MAX_AHEAD_S;
  } catch {
    return false;
  }
}
