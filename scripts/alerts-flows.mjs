// Drives the phone side of push alerts in Chromium, against the stand-in
// database, and checks what the server is told and what the phone shows:
//
//   - /sw.js has its own headers, no page policy and no cookie;
//   - nothing of alerts exists before consent, after consent, or on /demo,
//     until the Alerts screen prepares them (prepareAlerts());
//   - the tap that turns alerts on calls pushManager.subscribe() inside the
//     click, before the server action (which checks Turnstile);
//   - every push shows exactly one notification, with the right words,
//     tagged with the sighting id, even when the message is broken or empty;
//   - tapping one opens the sighting on /, never /demo, with nothing in the URL;
//   - every change to what is watched reaches the server, and a failed one
//     is sent again when the network is back or on the next open;
//   - turning off, Clear this device and deleting the account delete on the
//     server, unsubscribe even if that failed, then remove the copy and the
//     worker; alerts that went off by themselves say why;
//   - a new Realtime sighting near the live position shows the in-app notice
//     once, and one farther away shows nothing;
//   - no endpoint, key, secret or coordinate reaches a URL, a console, the
//     server's output or this script's output.
//
//   node scripts/alerts-flows.mjs           starts the stand-ins and `next dev`
//   Options: --only headers,fresh,enable,push,tap,sync,stop,teardown,realtime
//            --port 3210  --keep-logs <dir>  (the app's output is kept there)
//
// It starts scripts/mock-supabase.mjs on ports 54321 (the real map) and
// 54322 (the demo), and `next dev` with NEXT_PUBLIC_TURNSTILE_SITE_KEY empty
// and a throwaway NEXT_PUBLIC_VAPID_PUBLIC_KEY made here (never a real key),
// so nothing reaches Supabase, Cloudflare or a push service. Map tiles are
// blocked and the place search and reverse lookup are stubbed. The browser's
// push subscription is a stub (PushManager.prototype.subscribe and
// getSubscription, through addInitScript), and pushes are delivered with
// CDP's ServiceWorker.deliverPushMessage. The app's alerts functions are
// reached through window.__icepikAlerts, which only `next dev` has.
//
// It prints only what passed and failed: never an endpoint, a key, a secret
// or a coordinate.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdtempSync, readFileSync, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > -1 ? process.argv[at + 1] : fallback;
}
const PORT = Number(option("port", "3210"));
const url = `http://127.0.0.1:${PORT}`;
const only = option("only")?.split(",");
const wants = (name) => !only || only.includes(name);
const logDir = option("keep-logs") ?? mkdtempSync(join(tmpdir(), "icepik-alerts-"));
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
const MOCKS = { real: "http://127.0.0.1:54321", demo: "http://127.0.0.1:54322" };

const firstLine = (error) => String(error?.message ?? error).split("\n")[0];
const printed = [];
function say(line) {
  printed.push(line);
  console.log(line);
}
const children = [];
function stopChildren() {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
}
for (const event of ["unhandledRejection", "uncaughtException"]) {
  process.on(event, (error) => {
    say(`Stopped: ${firstLine(error)}`);
    stopChildren();
    process.exit(2);
  });
}

// --- Results ---------------------------------------------------------------

const results = [];
function check(name, ok, detail = "") {
  results.push(Boolean(ok));
  say(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
  return ok;
}

// Everything this run must never leak: scanned for at the end, never printed.
const secrets = new Set();
const remember = (value) => {
  if (typeof value === "string" && value.length >= 6) secrets.add(value);
  return value;
};

// --- Test places (made up, in Philadelphia) --------------------------------

const PLACES = {
  home: { lat: 39.9612, lng: -75.1588 },
  work: { lat: 39.9811, lng: -75.1297 },
  custom: { id: "test-place-clinic", name: "Clinic", lat: 39.9405, lng: -75.1503 },
};
for (const p of Object.values(PLACES)) {
  remember(String(p.lat));
  remember(String(p.lng));
}
// The live position for the in-app notice: the stand-in's fixture centre.
const HERE = { lat: 39.9526, lng: -75.1652 };
remember(String(HERE.lat));
const FIXTURE_ID = "00000000-0000-4000-8000-000000000001";

// --- Stand-ins and the app ---------------------------------------------------

const { publicKey } = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const VAPID_KEY = remember(Buffer.from(await webcrypto.subtle.exportKey("raw", publicKey)).toString("base64url"));

async function portBusy(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}
for (const port of [54321, 54322, PORT]) {
  if (await portBusy(port)) {
    say(`Stopped: port ${port} is already in use. Stop what runs there first.`);
    process.exit(2);
  }
}

const serverLogPath = join(logDir, "app-output.txt");
const serverLog = createWriteStream(serverLogPath);
function start(command, args, env, name) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => serverLog.write(chunk));
  child.stderr.on("data", (chunk) => serverLog.write(chunk));
  child.on("exit", (code) => {
    if (code && code !== 143 && code !== null) serverLog.write(`[${name} exited ${code}]\n`);
  });
  children.push(child);
  return child;
}
start(process.execPath, ["scripts/mock-supabase.mjs"], { MOCK_PORT: "54321" }, "mock");
start(process.execPath, ["scripts/mock-supabase.mjs"], { MOCK_PORT: "54322", MOCK_DEMO: "1" }, "mock-demo");
const appEnv = {
  NEXT_PUBLIC_SUPABASE_URL: MOCKS.real,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  NEXT_PUBLIC_DEMO_SUPABASE_URL: MOCKS.demo,
  NEXT_PUBLIC_DEMO_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SECRET_KEY: "test-secret-key",
  DEMO_SUPABASE_SECRET_KEY: "test-secret-key",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "",
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: VAPID_KEY,
  TURNSTILE_SECRET_KEY: "",
  VERCEL_ENV: "",
  NEXT_TELEMETRY_DISABLED: "1",
};
start("node_modules/.bin/next", ["dev", "-p", String(PORT), "-H", "127.0.0.1"], appEnv, "next");

async function waitFor(test, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await test()) return;
    } catch {
      // Not yet.
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
await waitFor(async () => (await fetch(`${MOCKS.real}/__mock/push`)).ok, 20000, "the stand-in");
await waitFor(async () => (await fetch(`${MOCKS.demo}/__mock/push`)).ok, 20000, "the demo stand-in");
await waitFor(async () => (await fetch(`${url}/sw.js`)).ok, 180000, "next dev");

const mockRows = async () => (await (await fetch(`${MOCKS.real}/__mock/push`)).json());
const clearMockRows = () => fetch(`${MOCKS.real}/__mock/push`, { method: "POST" });
const mockRequests = async () => (await (await fetch(`${MOCKS.real}/__mock/requests`)).json());
const clearMockRequests = () => fetch(`${MOCKS.real}/__mock/requests`, { method: "POST" });
const pushCalls = async () =>
  (await mockRequests()).map((r) => r.path.match(/\/rpc\/(push_\w+)$/)?.[1]).filter(Boolean);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- The browser -------------------------------------------------------------

// The full Chromium in its new headless mode: the headless shell reports
// notification permission as denied whatever is granted.
const browser = await chromium.launch({ channel: "chromium" });
const requestUrls = [];
const consoleLines = [];

// Runs in every page before its own scripts: a stand-in push subscription
// (kept in sessionStorage, so it outlives a reload), a log of the calls the
// alerts make, and a way to take notification permission away.
function pageStubs() {
  const log = (window.__alertLog = []);
  const record = (name, extra = {}) => log.push({ name, inClick: window.__inClick === true, ...extra });
  const KEY = "__pushStub";
  const b64 = (n) => {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const read = () => {
    try {
      return JSON.parse(sessionStorage.getItem(KEY));
    } catch {
      return null;
    }
  };
  const make = (state) =>
    state && {
      endpoint: state.endpoint,
      expirationTime: null,
      options: { userVisibleOnly: true },
      getKey: () => null,
      toJSON: () => ({ endpoint: state.endpoint, expirationTime: null, keys: { p256dh: state.p256dh, auth: state.auth } }),
      unsubscribe: () => {
        record("unsubscribe");
        sessionStorage.removeItem(KEY);
        return Promise.resolve(true);
      },
    };
  if (typeof PushManager !== "undefined") {
    PushManager.prototype.subscribe = function (options) {
      record("subscribe", {
        userVisibleOnly: options?.userVisibleOnly === true,
        hasKey: Boolean(options?.applicationServerKey),
      });
      const state = {
        endpoint: `https://fcm.googleapis.com/fcm/send/alerts-test-${b64(18)}`,
        p256dh: b64(65),
        auth: b64(16),
      };
      sessionStorage.setItem(KEY, JSON.stringify(state));
      return Promise.resolve(make(state));
    };
    PushManager.prototype.getSubscription = function () {
      record("getSubscription");
      return Promise.resolve(make(read()));
    };
  }
  const realFetch = window.fetch;
  window.fetch = function (input, init) {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.has("next-action")) record("action");
    return realFetch.apply(this, arguments);
  };
  if (typeof Notification !== "undefined") {
    const real = Object.getOwnPropertyDescriptor(Notification, "permission");
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      get() {
        return sessionStorage.getItem("__perm") || real.get.call(Notification);
      },
    });
  }
}

async function newContext({ position = null } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    timezoneId: "UTC",
    locale: "en-US",
  });
  await context.grantPermissions(position ? ["notifications", "geolocation"] : ["notifications"], { origin: url });
  if (position) await context.setGeolocation({ latitude: position.lat, longitude: position.lng, accuracy: 20 });
  await context.addInitScript(
    (answer) => {
      if (!localStorage.getItem("icepik.location")) localStorage.setItem("icepik.location", answer);
    },
    position ? "granted" : "denied",
  );
  await context.addInitScript(pageStubs);
  await context.route("**/*cartocdn.com/**", (route) => route.abort());
  await context.route("**/api/search**", (route) => route.fulfill({ contentType: "application/json", body: "[]" }));
  await context.route("**/api/reverse**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ label: "Market Street" }) }),
  );
  context.on("request", (request) => requestUrls.push(request.url()));
  context.on("console", (message) => consoleLines.push(message.text()));
  return context;
}

async function openPage(context, path = "/", { consent = true } = {}) {
  const page = await context.newPage();
  page.on("console", (message) => consoleLines.push(message.text()));
  page.on("pageerror", (error) => {
    consoleLines.push(String(error));
    say(`      page error: ${firstLine(error)}`);
  });
  await page.goto(`${url}${path}`, { waitUntil: "domcontentloaded" });
  if (consent) await agree(page);
  return page;
}

async function agree(page) {
  await page.waitForSelector(".consent-text", { timeout: 120000 });
  await page.waitForFunction(
    () => {
      const box = document.querySelector(".consent-text");
      box.scrollTop = box.scrollHeight;
      return document.querySelector(".consent-agree")?.getAttribute("aria-disabled") === "false";
    },
    null,
    { polling: 250, timeout: 60000 },
  );
  await page.click(".consent-agree");
  await waitForMap(page);
}

async function waitForMap(page) {
  await page.waitForSelector(".pin-icon", { state: "attached", timeout: 120000 });
  await page.waitForFunction(() => window.__icepikAlerts && !document.querySelector(".starter"), null, {
    timeout: 60000,
  });
}

async function reload(page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForMap(page);
}

// Saves the test places on the real map (as the map's own buttons would).
async function savePlaces(page, { home = true, work = true, custom = true } = {}) {
  await page.evaluate(
    ({ PLACES, home, work, custom }) => {
      const places = {};
      if (home) places.home = PLACES.home;
      if (work) places.work = PLACES.work;
      localStorage.setItem("icepik.places", JSON.stringify(places));
      localStorage.setItem("icepik.custom-places", JSON.stringify(custom ? [PLACES.custom] : []));
      window.dispatchEvent(new StorageEvent("storage", { key: "icepik.places" }));
    },
    { PLACES, home, work, custom },
  );
}

const alerts = (page, name, ...args) =>
  page.evaluate(({ name, args }) => window.__icepikAlerts[name](...args), { name, args });

const settings = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("icepik.alerts") ?? "null"));

// What exists of alerts in this browser.
const footprint = (page) =>
  page.evaluate(async () => ({
    workers: (await navigator.serviceWorker.getRegistrations()).length,
    database: (await indexedDB.databases()).some((db) => db.name === "icepik-alerts"),
    caches: (await caches.keys()).length,
  }));

// Reads keys of the alerts' IndexedDB copy without creating it.
const readCopy = (page, keys) =>
  page.evaluate(
    (keys) =>
      new Promise((resolve) => {
        const request = indexedDB.open("icepik-alerts");
        request.onupgradeneeded = () => request.transaction.abort();
        request.onerror = () => resolve(null);
        request.onsuccess = () => {
          const db = request.result;
          const out = {};
          const tx = db.transaction("copy", "readonly");
          for (const key of keys) {
            const get = tx.objectStore("copy").get(key);
            get.onsuccess = () => (out[key] = get.result ?? null);
          }
          tx.oncomplete = () => {
            db.close();
            resolve(out);
          };
        };
      }),
    keys,
  );

const writeCopyKey = (page, key, value) =>
  page.evaluate(
    ({ key, value }) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("icepik-alerts");
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("copy", "readwrite");
          tx.objectStore("copy").put(value, key);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { key, value },
  );

// The squares the app would send for the current settings, worked out in
// the page with the same code (lib/push-cells.ts through the app).
const expectedCells = (page, last = null) =>
  page.evaluate(
    (last) => {
      const s = JSON.parse(localStorage.getItem("icepik.alerts"));
      const saved = JSON.parse(localStorage.getItem("icepik.places") ?? "{}");
      const custom = JSON.parse(localStorage.getItem("icepik.custom-places") ?? "[]");
      const spots = s.placeIds
        .map((id) => (id === "home" || id === "work" ? saved[id] : custom.find((p) => p.id === id)))
        .filter(Boolean);
      return window.__icepikAlerts.alertCells(spots, last, s.distanceMiles);
    },
    last,
  );

// Keeps the secrets of the current subscription and device out of every
// output: scanned for at the end.
async function rememberDevice(page) {
  const stub = await page.evaluate(() => sessionStorage.getItem("__pushStub"));
  if (stub) {
    const { endpoint, p256dh, auth } = JSON.parse(stub);
    remember(endpoint);
    remember(p256dh);
    remember(auth);
  }
  const copy = await readCopy(page, ["device"]);
  if (copy?.device) {
    remember(copy.device.id);
    remember(copy.device.secret);
  }
}

// The tap that turns alerts on, from a real click on a button of this
// test's own (the Alerts screen comes in part B). Marks the click so the
// stub can tell whether subscribe() ran inside it.
async function tapEnable(page) {
  await page.evaluate(() => {
    document.querySelector("#test-enable")?.remove();
    const button = document.createElement("button");
    button.id = "test-enable";
    button.type = "button";
    button.textContent = "Test: turn on alerts";
    button.style.cssText = "position:fixed;top:0;left:0;z-index:2147483647;padding:12px";
    button.addEventListener("click", () => {
      window.__inClick = true;
      window.__enabling = window.__icepikAlerts.enableAlerts("", true);
      window.__inClick = false;
    });
    document.body.append(button);
  });
  await page.click("#test-enable");
  const result = await page.evaluate(() => window.__enabling);
  await page.evaluate(() => document.querySelector("#test-enable")?.remove());
  await rememberDevice(page);
  return result;
}

async function enableWith(page, patch = { placeIds: ["home"] }) {
  await alerts(page, "updateAlertSettings", patch);
  const ready = await alerts(page, "prepareAlerts");
  if (!ready) throw new Error("prepareAlerts failed");
  const result = await tapEnable(page);
  if (!result.ok) throw new Error(`enableAlerts refused: ${result.message}`);
  return result;
}

// The app's notices as screen readers hear them (its status lines),
// collected as they change.
async function watchNotices(page) {
  await page.evaluate(() => {
    window.__notices = [];
    const read = () => {
      for (const el of document.querySelectorAll("[role=status]")) {
        const text = el.textContent.trim();
        if (text && !window.__notices.includes(text)) window.__notices.push(text);
      }
    };
    // What shows already (a notice from the open), then every change.
    read();
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}
const notices = (page) => page.evaluate(() => window.__notices ?? []);

// --- 1. /sw.js headers ---------------------------------------------------------

if (wants("headers")) {
  const sw = await fetch(`${url}/sw.js`);
  const body = await sw.text();
  check(
    "/sw.js: Content-Type application/javascript; charset=utf-8",
    sw.headers.get("content-type") === "application/javascript; charset=utf-8",
    sw.headers.get("content-type"),
  );
  check(
    "/sw.js: Cache-Control no-cache, no-store, must-revalidate",
    sw.headers.get("cache-control") === "no-cache, no-store, must-revalidate",
    sw.headers.get("cache-control"),
  );
  check(
    "/sw.js: its own CSP only (default-src 'self'; script-src 'self')",
    sw.headers.get("content-security-policy") === "default-src 'self'; script-src 'self'",
    sw.headers.get("content-security-policy"),
  );
  check("/sw.js: no Set-Cookie", !sw.headers.has("set-cookie"));
  check("public/sw.js has no fetch handler", !/addEventListener\(\s*["']fetch["']/.test(body) && !/onfetch/.test(body));
  check("public/sw.js uses no Cache Storage", !/\bcaches\./.test(body));
  const home = await fetch(`${url}/`);
  const csp = home.headers.get("content-security-policy") ?? "";
  check("/ still has the page CSP and Referrer-Policy", csp.includes("worker-src 'self' blob:") && home.headers.get("referrer-policy") === "strict-origin-when-cross-origin");
}

// --- 2. Nothing before the Alerts screen ----------------------------------------

if (wants("fresh")) {
  const context = await newContext();
  const page = await openPage(context, "/", { consent: false });
  await page.waitForSelector(".consent-text", { timeout: 120000 });
  let seen = await footprint(page);
  check("Before consent: no service worker, no icepik-alerts database", !seen.workers && !seen.database, JSON.stringify(seen));
  await agree(page);
  await sleep(1500);
  seen = await footprint(page);
  check("After consent on /: no service worker, no database", !seen.workers && !seen.database, JSON.stringify(seen));
  await reload(page);
  await sleep(1500);
  seen = await footprint(page);
  check("After a reload: still none", !seen.workers && !seen.database, JSON.stringify(seen));
  const support = await alerts(page, "alertSupport");
  check("alertSupport() is ok here", support === "ok", support);
  check("prepareAlerts() registers the worker and waits until it's active", await alerts(page, "prepareAlerts"));
  seen = await footprint(page);
  const active = await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration("/"))?.active));
  check("...then exactly one worker, active, and still no database", seen.workers === 1 && active && !seen.database, JSON.stringify(seen));
  await alerts(page, "releaseAlerts");
  seen = await footprint(page);
  check("releaseAlerts() with alerts off leaves nothing", !seen.workers && !seen.database, JSON.stringify(seen));
  await context.close();

  const demoContext = await newContext();
  const demo = await openPage(demoContext, "/demo");
  await sleep(2000);
  seen = await footprint(demo);
  check("On /demo after consent: no worker, no database", !seen.workers && !seen.database, JSON.stringify(seen));
  const log = await demo.evaluate(() => window.__alertLog.map((e) => e.name));
  check("On /demo no alerts code touched the push subscription", !log.includes("getSubscription") && !log.includes("subscribe"), log.join(","));
  await demoContext.close();
}

// --- 3. Turning alerts on: subscribe() inside the tap -----------------------------

if (wants("enable") || wants("push") || wants("tap")) {
  await clearMockRows();
  await clearMockRequests();
  const context = await newContext();
  const page = await openPage(context, "/");
  await savePlaces(page);
  await sleep(300);

  if (wants("enable")) {
    await alerts(page, "prepareAlerts");
    await page.evaluate(() => (window.__alertLog.length = 0));
    const noPlace = await page.evaluate(() => window.__icepikAlerts.enableAlerts("", true));
    check("enableAlerts() refuses with no place switched on", !noPlace.ok && /at least one place/.test(noPlace.message), noPlace.message);
    await alerts(page, "updateAlertSettings", { placeIds: ["home"] });
    const unticked = await page.evaluate(() => window.__icepikAlerts.enableAlerts("", false));
    check("...and with the warning's box unticked", !unticked.ok && /Tick the box/.test(unticked.message), unticked.message);
    const calls = await page.evaluate(() => window.__alertLog.map((e) => e.name));
    check("...and then calls neither subscribe() nor the server", !calls.includes("subscribe") && !calls.includes("action") && !(await pushCalls()).includes("push_create"), calls.join(","));
    await page.evaluate(() => (window.__alertLog.length = 0));
    await clearMockRequests();
  }

  const result = await enableWith(page, { placeIds: ["home", "test-place-clinic"] });
  check("Turning alerts on works", result.ok, result.message);
  const log = await page.evaluate(() => window.__alertLog);
  const subscribeAt = log.findIndex((e) => e.name === "subscribe");
  const actionAt = log.findIndex((e) => e.name === "action");
  check(
    "subscribe() runs inside the click, before anything waits",
    subscribeAt > -1 && log[subscribeAt].inClick === true,
    JSON.stringify(log.map((e) => `${e.name}${e.inClick ? "*" : ""}`)),
  );
  check("subscribe() asks for userVisibleOnly with the VAPID key", log[subscribeAt]?.userVisibleOnly && log[subscribeAt]?.hasKey);
  check(
    "createPushSubscription (with its Turnstile check) comes after subscribe(), outside the click",
    actionAt > subscribeAt && log[actionAt].inClick === false,
  );
  check("The server got push_create", (await pushCalls()).includes("push_create"));
  let rows = await mockRows();
  const expected = await expectedCells(page);
  check("The server keeps one row with the squares of the watched places", rows.length === 1 && JSON.stringify(rows[0].cells) === JSON.stringify(expected), `${rows.length} rows`);
  const s = await settings(page);
  check("Settings say on", s?.on === true);
  const copy = await readCopy(page, ["device", "places", "settings", "texts", "pending"]);
  check(
    "The device copy holds the device, the watched places with labels, the settings and the texts",
    copy?.device?.id === rows[0]?.id &&
      /^[A-Za-z0-9_-]{43}$/.test(copy.device.secret) &&
      copy.places.length === 2 &&
      copy.places.map((p) => p.label).join(",") === "Home,Clinic" &&
      copy.settings.distanceMiles === 1 &&
      copy.texts?.v === 1 &&
      copy.pending === null,
  );

  if (wants("enable")) {
    // A second tap with an old subscription the server already has.
    const before = await page.evaluate(() => sessionStorage.getItem("__pushStub"));
    await page.evaluate(() => localStorage.setItem("icepik.alerts", JSON.stringify({ ...JSON.parse(localStorage.getItem("icepik.alerts")), on: false })));
    const taken = await page.evaluate(
      (stub) =>
        new Promise((resolve) => {
          // Keep the old endpoint: the stub hands out the stored one.
          const realSubscribe = PushManager.prototype.subscribe;
          PushManager.prototype.subscribe = function (options) {
            const out = realSubscribe.call(this, options);
            sessionStorage.setItem("__pushStub", stub);
            return out.then(() => this.getSubscription());
          };
          window.__inClick = true;
          const run = window.__icepikAlerts.enableAlerts("", true);
          window.__inClick = false;
          run.then((r) => {
            PushManager.prototype.subscribe = realSubscribe;
            resolve(r);
          });
        }),
      before,
    );
    check("endpoint_taken: refused with 'tap again', and the old subscription is dropped", !taken.ok && /tap Turn on alerts again/.test(taken.message) && (await page.evaluate(() => sessionStorage.getItem("__pushStub"))) === null);
    // Back to the working state for the next sections.
    await clearMockRows();
    await page.evaluate(() => sessionStorage.removeItem("__pushStub"));
    await alerts(page, "disableAlerts");
    await enableWith(page, { placeIds: ["home", "test-place-clinic"] });
    rows = await mockRows();
    check("...and a fresh tap turns alerts on again", rows.length === 1);
  }

  // --- 4. Pushes ---------------------------------------------------------------

  if (wants("push")) {
    const cdp = await context.newCDPSession(page);
    const registrations = [];
    cdp.on("ServiceWorker.workerRegistrationUpdated", (event) => registrations.push(...event.registrations));
    await cdp.send("ServiceWorker.enable");
    await waitFor(() => registrations.some((r) => !r.isDeleted && r.scopeURL === `${url}/`), 10000, "the registration");
    const registrationId = registrations.filter((r) => !r.isDeleted && r.scopeURL === `${url}/`).at(-1).registrationId;

    const message = (fields) => {
      const payload = { v: 1, ...fields, pad: "" };
      payload.pad = " ".repeat(512 - JSON.stringify(payload).length);
      return JSON.stringify(payload);
    };
    const near = { lat: 39.963, lng: -75.157 }; // 0.16 mi from Home
    const far = { lat: 39.99, lng: -75.2 }; // ~3 mi from the nearest watched place
    remember(String(near.lat));
    remember(String(far.lat));
    const shown = () =>
      page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration("/");
        return (await reg.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, icon: n.icon, data: n.data, timestamp: n.timestamp, requireInteraction: n.requireInteraction }));
      });
    const closeAll = () =>
      page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration("/");
        (await reg.getNotifications()).forEach((n) => n.close());
      });
    let n = 0;
    async function deliver(data) {
      await closeAll();
      await waitFor(async () => (await shown()).length === 0, 5000, "no notifications");
      await cdp.send("ServiceWorker.deliverPushMessage", { origin: url, registrationId, data });
      await waitFor(async () => (await shown()).length >= 1, 10000, "a notification");
      await sleep(400);
      return shown();
    }
    const id = () => `00000000-0000-4000-8000-${String(900 + ++n).padStart(12, "0")}`;
    const at = "2026-11-27T12:00:00.000Z";

    let sid = id();
    let list = await deliver(message({ id: sid, ...near, cat: "raid", at }));
    check(
      "Push inside the distance (private): one notification, category and 'near one of your places'",
      list.length === 1 && list[0].title === "Raid reported near one of your places" && list[0].body === "Open ICEPik to see where.",
      JSON.stringify(list.map((x) => [x.title, x.body])),
    );
    check("...tagged with the sighting id, with the icon, the time and { id, lat, lng }", list[0]?.tag === sid && list[0].icon.endsWith("/icons/icon-192.png") && list[0].timestamp === Date.parse(at) && list[0].data?.id === sid && typeof list[0].data.lat === "number" && !list[0].requireInteraction);
    sid = id();
    list = await deliver(message({ id: sid, ...far, cat: "patrol", at }));
    check(
      "Push beyond the distance (private): the same words, no place, no distance",
      list.length === 1 && list[0].title === "Patrol reported near one of your places" && list[0].body === "Open ICEPik to see where." && list[0].tag === sid,
      JSON.stringify(list.map((x) => [x.title, x.body])),
    );
    check("updateAlertSettings({ showDetails: true })", (await alerts(page, "updateAlertSettings", { showDetails: true })).ok);
    sid = id();
    list = await deliver(message({ id: sid, ...near, cat: "checkpoint", at }));
    check(
      "Push inside the distance (details on): place and distance",
      list.length === 1 && list[0].title === "Checkpoint 0.2 mi from Home" && list[0].body === "Open ICEPik to see it on the map." && list[0].tag === sid,
      JSON.stringify(list.map((x) => [x.title, x.body])),
    );
    sid = id();
    list = await deliver(message({ id: sid, ...far, cat: "other", at }));
    check(
      "Push beyond the distance (details on): says it's farther than the alert distance",
      list.length === 1 && /^Sighting \d+\.\d mi from (Home|Clinic)$/.test(list[0].title) && list[0].body === "Farther than your 1 mi alert distance." && list[0].tag === sid,
      JSON.stringify(list.map((x) => [x.title, x.body])),
    );
    const savedPlaces = (await readCopy(page, ["places"])).places;
    await writeCopyKey(page, "places", []);
    sid = id();
    list = await deliver(message({ id: sid, ...near, cat: "vehicle", at }));
    check(
      "Push with no watched place stored: category and 'Open ICEPik for details.'",
      list.length === 1 && list[0].title === "Vehicle reported" && list[0].body === "Open ICEPik for details." && list[0].tag === sid,
      JSON.stringify(list.map((x) => [x.title, x.body])),
    );
    await writeCopyKey(page, "places", savedPlaces);
    list = await deliver("this is not json");
    check("Broken push: one notification, 'New ICEPik alert'", list.length === 1 && list[0].title === "New ICEPik alert", JSON.stringify(list.map((x) => x.title)));
    list = await deliver("");
    check("Empty push: one notification, 'New ICEPik alert'", list.length === 1 && list[0].title === "New ICEPik alert", JSON.stringify(list.map((x) => x.title)));
    list = await deliver(message({ id: "not-a-uuid", ...near, cat: "raid", at }));
    check("Push with a bad id: one notification, 'New ICEPik alert'", list.length === 1 && list[0].title === "New ICEPik alert");
    await closeAll();
    await alerts(page, "updateAlertSettings", { showDetails: false });
    const seen = await footprint(page);
    check("Cache Storage stays empty", seen.caches === 0);
    await cdp.detach();
  }

  // --- 5. Tapping a notification ------------------------------------------------

  if (wants("tap")) {
    const worker = context.serviceWorkers().find((w) => w.url() === `${url}/sw.js`) ?? (await context.waitForEvent("serviceworker"));
    const tap = (data) =>
      worker.evaluate(
        (data) =>
          // handleClick is public/sw.js's notificationclick handler.
          handleClick({ notification: { data, close() {} } }),
        data,
      );
    await page.evaluate(() => document.querySelector(".detail-card") === null);
    await tap({ id: FIXTURE_ID, lat: 39.953, lng: -75.165 });
    remember("39.953");
    await page.waitForSelector(".detail-card", { timeout: 10000 }).catch(() => undefined);
    const card = await page.evaluate(() => document.querySelector(".detail-card")?.textContent ?? "");
    check("Tapping an alert with / open shows its sighting there", /Market Street & 15th/.test(card), card.slice(0, 80));
    check("...and the URL stays exactly /", page.url() === `${url}/`, page.url().replace(/[?#].*/, "?…"));
    check("...and pendingOpen is cleared", (await readCopy(page, ["pendingOpen"]))?.pendingOpen === null);
    await page.keyboard.press("Escape");
    await watchNotices(page);
    await tap({ id: "00000000-0000-4000-8000-000000000999", lat: 39.95, lng: -75.17 });
    await waitFor(async () => (await notices(page)).includes("That sighting is no longer on the map."), 10000, "the gone notice").catch(() => undefined);
    check("An alert for a sighting that's gone centres the map and says so", (await notices(page)).includes("That sighting is no longer on the map."));

    // Only /demo open: the tap opens /, never /demo, and the new page shows it.
    const demo = await openPage(context, "/demo", { consent: false });
    await waitForMap(demo);
    await page.close();
    const opened = await worker.evaluate(async (data) => {
      const urls = [];
      const real = self.clients.openWindow.bind(self.clients);
      self.clients.openWindow = (u) => {
        urls.push(u);
        return Promise.resolve(null);
      };
      await handleClick({ notification: { data, close() {} } });
      self.clients.openWindow = real;
      return urls;
    }, { id: FIXTURE_ID, lat: 39.953, lng: -75.165 });
    check("With only /demo open, the tap opens / (never /demo, nothing in the URL)", opened.length === 1 && opened[0] === "/", JSON.stringify(opened));
    const fresh = await openPage(context, "/", { consent: false });
    await waitForMap(fresh);
    await fresh.waitForSelector(".detail-card", { timeout: 15000 }).catch(() => undefined);
    const freshCard = await fresh.evaluate(() => document.querySelector(".detail-card")?.textContent ?? "");
    check("...and / opens the sighting from pendingOpen when it loads", /Market Street & 15th/.test(freshCard));
    await demo.close();
    await alerts(fresh, "disableAlerts");
    await context.close();
  } else {
    await alerts(page, "disableAlerts");
    await context.close();
  }
}

// --- 6. Keeping the server in step ----------------------------------------------

if (wants("sync")) {
  await clearMockRows();
  const context = await newContext({ position: HERE });
  const page = await openPage(context, "/");
  await savePlaces(page);
  await enableWith(page, { placeIds: ["home"] });
  const serverCells = async () => JSON.stringify((await mockRows())[0]?.cells ?? null);
  const agrees = async (last = null) => (await serverCells()) === JSON.stringify(await expectedCells(page, last));
  const settle = async (last = null) => {
    await waitFor(agrees.bind(null, last), 8000, "the server's squares").catch(() => undefined);
    return agrees(last);
  };

  check("Distance 2 mi reaches the server", (await alerts(page, "updateAlertSettings", { distanceMiles: 2 })).ok && (await settle()));
  check("Switching a place on reaches the server", (await alerts(page, "updateAlertSettings", { placeIds: ["home", "work"] })).ok && (await settle()));
  check("Switching a place off reaches the server", (await alerts(page, "updateAlertSettings", { placeIds: ["work"] })).ok && (await settle()));
  const keep = await alerts(page, "updateAlertSettings", { placeIds: [] });
  check("Switching off the last place is refused, and the old settings stay", !keep.ok && /Keep at least one place/.test(keep.message) && (await settings(page)).placeIds.join() === "work");
  const six = await alerts(page, "updateAlertSettings", { placeIds: ["home", "work", "a", "b", "c", "d"] });
  check("A sixth place is refused", !six.ok && (await settings(page)).placeIds.join() === "work");
  await page.evaluate(() => {
    localStorage.setItem("icepik.places", JSON.stringify({ ...JSON.parse(localStorage.getItem("icepik.places")), work: { lat: 40.0011, lng: -75.1102 } }));
    window.dispatchEvent(new StorageEvent("storage", { key: "icepik.places" }));
  });
  remember("40.0011");
  check("Moving a watched place reaches the server", await settle());

  // A failed call is kept and sent again when the network is back.
  const before = await serverCells();
  await page.route(`${url}/`, (route) => (route.request().headers()["next-action"] ? route.abort() : route.continue()));
  await alerts(page, "updateAlertSettings", { distanceMiles: 5 });
  await sleep(2500);
  const pending = (await readCopy(page, ["pending"]))?.pending;
  check("Offline: the change waits in 'pending' and the server keeps the old squares", (await serverCells()) === before && Array.isArray(pending) && pending.length > 0);
  await page.unroute(`${url}/`);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  check("Back online: the pending squares reach the server", await settle());
  await waitFor(async () => (await readCopy(page, ["pending"]))?.pending === null, 5000, "pending cleared").catch(() => undefined);
  check("...and 'pending' is cleared", (await readCopy(page, ["pending"]))?.pending === null);

  // A failed call is sent again on the next open.
  await page.route(`${url}/`, (route) => (route.request().headers()["next-action"] ? route.abort() : route.continue()));
  await alerts(page, "updateAlertSettings", { distanceMiles: 1 });
  await sleep(2500);
  check("Offline again: the server still has the old squares", !(await agrees()));
  await page.unroute(`${url}/`);
  await clearMockRequests();
  await reload(page);
  check("Next open: the current squares reach the server", await settle());
  check("...with one push_update (the renewal) and no push_create", (await pushCalls()).filter((c) => c === "push_update").length >= 1 && !(await pushCalls()).includes("push_create"));

  // The last-opened option.
  const lastOn = await alerts(page, "updateAlertSettings", { lastLocation: true });
  check("Turning the last-opened option on is accepted", lastOn.ok);
  const lastSpot = { lat: Math.round(HERE.lat * 1000) / 1000, lng: Math.round(HERE.lng * 1000) / 1000 };
  await waitFor(async () => (await readCopy(page, ["last"]))?.last?.lat === lastSpot.lat, 10000, "the last spot").catch(() => undefined);
  const stored = (await readCopy(page, ["last"]))?.last;
  check("The live position becomes the last-opened spot, rounded to 0.001°", stored?.lat === lastSpot.lat && stored?.lng === lastSpot.lng);
  check("...and its squares reach the server", await settle(lastSpot));
  check("With the last-opened spot known, switching off every place is allowed", (await alerts(page, "updateAlertSettings", { placeIds: [] })).ok && (await settle(lastSpot)));
  check("Turning the last-opened option off with places switched on reaches the server", (await alerts(page, "updateAlertSettings", { placeIds: ["home"] })).ok && (await alerts(page, "updateAlertSettings", { lastLocation: false })).ok && (await settle()));
  check("...and forgets the last-opened spot", (await readCopy(page, ["last"]))?.last === null);

  // Places renamed or removed on the map.
  await page.evaluate(() => {
    localStorage.setItem("icepik.places", JSON.stringify({ work: JSON.parse(localStorage.getItem("icepik.places")).work }));
    window.dispatchEvent(new StorageEvent("storage", { key: "icepik.places" }));
  });
  await watchNotices(page);
  await waitFor(async () => (await settings(page)).on === false, 8000, "alerts off").catch(() => undefined);
  const off = await settings(page);
  check("Removing the last watched place turns alerts off ('no-places')", off.on === false && (await mockRows()).length === 0);
  await waitFor(async () => (await notices(page)).some((t) => /no places are left/.test(t)), 5000, "the notice").catch(() => undefined);
  check("...with a notice saying why", (await notices(page)).some((t) => /no places are left/.test(t)));
  const seen = await footprint(page);
  check("...and no worker or database is left", !seen.workers && !seen.database, JSON.stringify(seen));
  await context.close();
}

// --- 7. Alerts that stop by themselves ---------------------------------------------

if (wants("stop")) {
  await clearMockRows();
  const context = await newContext();
  const page = await openPage(context, "/");
  await savePlaces(page);
  await enableWith(page);
  // The server's row is gone (expired and purged).
  await clearMockRows();
  await reload(page);
  await watchNotices(page);
  await waitFor(async () => (await settings(page)).on === false, 10000, "alerts off").catch(() => undefined);
  check("not_found on open turns alerts off ('expired')", (await settings(page)).on === false);
  await waitFor(async () => (await notices(page)).some((t) => /subscription ended/.test(t)), 5000, "the notice").catch(() => undefined);
  check("...and a notice says they can be turned on again in Settings", (await notices(page)).some((t) => /subscription ended.*Settings/.test(t)));
  let seen = await footprint(page);
  check("...and no worker or database is left", !seen.workers && !seen.database, JSON.stringify(seen));

  await enableWith(page);
  await page.evaluate(() => sessionStorage.setItem("__perm", "denied"));
  await clearMockRequests();
  await reload(page);
  await watchNotices(page);
  await waitFor(async () => (await settings(page)).on === false, 10000, "alerts off").catch(() => undefined);
  check("Permission taken away: alerts turn off ('blocked') on open", (await settings(page)).on === false);
  check("...and the server row is deleted", (await mockRows()).length === 0 && (await pushCalls()).includes("push_delete"));
  await waitFor(async () => (await notices(page)).some((t) => /blocked/.test(t)), 5000, "the notice").catch(() => undefined);
  check("...with a notice", (await notices(page)).some((t) => /notifications for ICEPik were blocked/.test(t)));
  await page.evaluate(() => sessionStorage.removeItem("__perm"));

  await enableWith(page);
  await page.evaluate(() => sessionStorage.removeItem("__pushStub"));
  await reload(page);
  await waitFor(async () => (await settings(page)).on === false, 10000, "alerts off").catch(() => undefined);
  check("Subscription gone from the browser: alerts turn off on open", (await settings(page)).on === false && (await mockRows()).length === 0);

  // A new endpoint the worker couldn't hand over is sent on open.
  await enableWith(page);
  await writeCopyKey(page, "needsRenew", true);
  await page.evaluate(() => {
    const stub = JSON.parse(sessionStorage.getItem("__pushStub"));
    stub.endpoint = `${stub.endpoint}-renewed`;
    sessionStorage.setItem("__pushStub", JSON.stringify(stub));
  });
  await rememberDevice(page);
  await reload(page);
  await waitFor(async () => (await readCopy(page, ["needsRenew"]))?.needsRenew === false, 10000, "the renewal").catch(() => undefined);
  const renewed = await readCopy(page, ["needsRenew", "device"]);
  check("needsRenew: the new endpoint reaches the server on open", renewed?.needsRenew === false && renewed.device.endpoint.endsWith("-renewed"));

  // The worker's own renewal (pushsubscriptionchange) through /api/push/renew.
  const worker = context.serviceWorkers().find((w) => w.url() === `${url}/sw.js`);
  if (worker) {
    const stub = JSON.parse(await page.evaluate(() => sessionStorage.getItem("__pushStub")));
    const next = { endpoint: `${stub.endpoint}-2`, p256dh: stub.p256dh, auth: stub.auth };
    remember(next.endpoint);
    await worker.evaluate(
      (next) =>
        handleSubscriptionChange({
          newSubscription: { toJSON: () => ({ endpoint: next.endpoint, keys: { p256dh: next.p256dh, auth: next.auth } }) },
        }),
      next,
    );
    const after = await readCopy(page, ["needsRenew", "device"]);
    check("pushsubscriptionchange: the worker hands the new endpoint to /api/push/renew (204)", after?.needsRenew === false && after.device.endpoint === next.endpoint);
    await clearMockRows();
    await worker.evaluate(
      (next) =>
        handleSubscriptionChange({
          newSubscription: { toJSON: () => ({ endpoint: `${next.endpoint}-3`, keys: { p256dh: next.p256dh, auth: next.auth } }) },
        }),
      next,
    );
    check("...and sets needsRenew when the server refuses", (await readCopy(page, ["needsRenew"]))?.needsRenew === true);
  } else {
    check("The worker is reachable for the pushsubscriptionchange check", false, "no service worker handle");
  }
  await alerts(page, "disableAlerts");
  seen = await footprint(page);
  check("disableAlerts() leaves nothing", !seen.workers && !seen.database);
  await context.close();
}

// --- 8. Teardown ------------------------------------------------------------------

if (wants("teardown")) {
  await clearMockRows();
  const context = await newContext();
  const page = await openPage(context, "/");
  await savePlaces(page);

  const order = async (run) => {
    await page.evaluate(() => (window.__alertLog.length = 0));
    await clearMockRequests();
    await run();
    const log = await page.evaluate(() => window.__alertLog.map((e) => e.name));
    return { log, calls: await pushCalls(), seen: await footprint(page), s: await settings(page) };
  };

  await enableWith(page);
  let r = await order(() => alerts(page, "disableAlerts"));
  check(
    "Turning off: delete on the server, then unsubscribe, then no copy and no worker",
    r.calls.join() === "push_delete" && r.log.indexOf("action") > -1 && r.log.indexOf("action") < r.log.indexOf("unsubscribe") && !r.seen.workers && !r.seen.database && r.s.on === false && (await mockRows()).length === 0,
    `${r.log.join(",")} | ${r.calls.join(",")} | ${JSON.stringify(r.seen)}`,
  );

  await enableWith(page);
  await page.route(`${url}/`, (route) => (route.request().headers()["next-action"] ? route.abort() : route.continue()));
  r = await order(() => alerts(page, "disableAlerts"));
  await page.unroute(`${url}/`);
  check(
    "Turning off offline: the delete fails, but unsubscribe still runs and nothing is left",
    r.log.includes("unsubscribe") && !r.seen.workers && !r.seen.database && r.s.on === false,
    `${r.log.join(",")} | ${JSON.stringify(r.seen)}`,
  );
  await clearMockRows();

  // Clear this device, on /.
  await enableWith(page);
  await page.evaluate(() => (window.__alertLog.length = 0));
  await clearMockRequests();
  const rail = await page.locator(".rail-settings").isVisible();
  await page.click(rail ? ".rail-settings" : ".panel-settings");
  await page.click('[data-opens="clear"]');
  await page.click(".modal .danger-button");
  await page.waitForSelector(".consent-text", { timeout: 30000 });
  const clearLog = await page.evaluate(() => window.__alertLog.map((e) => e.name));
  let seen = await footprint(page);
  check(
    "Clear this device on /: delete on the server, unsubscribe, no copy, no worker, settings gone",
    (await pushCalls()).includes("push_delete") && clearLog.includes("unsubscribe") && !seen.workers && !seen.database && (await settings(page)) === null && (await mockRows()).length === 0,
    `${clearLog.join(",")} | ${JSON.stringify(seen)}`,
  );

  // Clear this device, on /demo: alerts belong to the browser.
  await agree(page);
  await savePlaces(page);
  await enableWith(page);
  const demo = await openPage(context, "/demo", { consent: false });
  await waitForMap(demo);
  await clearMockRequests();
  const demoRail = await demo.locator(".rail-settings").isVisible();
  await demo.click(demoRail ? ".rail-settings" : ".panel-settings");
  await demo.click('[data-opens="clear"]');
  await demo.click(".modal .danger-button");
  await demo.waitForSelector(".consent-text", { timeout: 30000 });
  seen = await footprint(demo);
  check(
    "Clear this device on /demo turns the browser's alerts off too",
    (await pushCalls()).includes("push_delete") && !seen.workers && !seen.database && (await mockRows()).length === 0,
    JSON.stringify(seen),
  );
  await demo.close();

  // Deleting the account (an anonymous one, as the stand-in makes).
  await page.reload({ waitUntil: "domcontentloaded" });
  await agree(page);
  await savePlaces(page);
  await enableWith(page);
  await clearMockRequests();
  await page.click((await page.locator(".rail-settings").isVisible()) ? ".rail-settings" : ".panel-settings");
  await page.click('[data-opens="delete"]');
  await page.click('.modal button[type="submit"].danger-button');
  await waitFor(async () => (await settings(page))?.on === false, 15000, "alerts off").catch(() => undefined);
  seen = await footprint(page);
  check(
    "Deleting the account on / turns alerts off (delete, unsubscribe, no copy, no worker)",
    (await pushCalls()).includes("push_delete") && !seen.workers && !seen.database && (await mockRows()).length === 0,
    JSON.stringify(seen),
  );
  await context.close();
}

// --- 9. The in-app notice -----------------------------------------------------------

if (wants("realtime")) {
  const context = await newContext({ position: HERE });
  const sockets = [];
  await context.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    const state = { ws, joins: [] };
    sockets.push(state);
    ws.onMessage((raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      const [joinRef, ref, topic, event, payload] = frame;
      if (event === "phx_join") {
        const changes = (payload?.config?.postgres_changes ?? []).map((filter, i) => ({ ...filter, id: 7000 + i }));
        state.joins.push({ joinRef, topic, ids: changes.map((c) => c.id) });
        ws.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: { postgres_changes: changes } }]));
      } else if (ref) {
        ws.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]));
      }
    });
  });
  const page = await openPage(context, "/");
  await waitFor(() => sockets.some((s) => s.joins.length > 0), 15000, "the Realtime join");
  // Time for the first position.
  await sleep(3000);
  await watchNotices(page);
  const insert = (record) => {
    for (const { ws, joins } of sockets) {
      for (const join of joins) {
        ws.send(
          JSON.stringify([
            join.joinRef,
            null,
            join.topic,
            "postgres_changes",
            {
              ids: join.ids,
              data: {
                type: "INSERT",
                schema: "public",
                table: "sightings",
                commit_timestamp: new Date().toISOString(),
                columns: [],
                record,
                errors: null,
              },
            },
          ]),
        );
      }
    }
  };
  const sighting = (n, lat, lng) => ({
    id: `00000000-0000-4000-8000-${String(800 + n).padStart(12, "0")}`,
    agent_count: 1,
    vehicle_count: null,
    category: "raid",
    confirm_count: 0,
    dispute_count: 0,
    created_at: new Date().toISOString(),
    description: "Realtime fixture",
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    lat,
    lng,
    location_label: `Realtime street ${n}`,
    verification_score: null,
    verification_status: "unverified",
  });
  const nearby = sighting(1, 39.956, -75.163); // ~0.27 mi away
  insert(nearby);
  insert(nearby);
  await sleep(3500);
  let seenNotices = (await notices(page)).filter((t) => t.startsWith("New sighting near you"));
  check("A new Realtime sighting within the distance shows the in-app notice once", seenNotices.length === 1 && seenNotices[0] === "New sighting near you: Raid, 0.3 mi away.", JSON.stringify(seenNotices));
  insert(sighting(2, 39.99, -75.21)); // ~3.6 mi away
  await sleep(3500);
  seenNotices = (await notices(page)).filter((t) => t.startsWith("New sighting near you"));
  check("One beyond the distance shows nothing", seenNotices.length === 1);
  await context.close();
}

await browser.close();
stopChildren();
serverLog.end();
await new Promise((resolve) => serverLog.on("finish", resolve));

// --- 10. Leaks ---------------------------------------------------------------------

const holds = (text) => [...secrets].some((secret) => text.includes(secret));
check("No endpoint, key, secret, id or coordinate in any request URL", !holds(requestUrls.join("\n")));
check("...nor in any console message", !holds(consoleLines.join("\n")));
const appOutput = readFileSync(serverLogPath, "utf8");
const leakingLines = appOutput.split("\n").filter(holds);
check(
  "...nor in the app's output",
  leakingLines.length === 0,
  leakingLines.every((line) => line.trimStart().startsWith("└─ ƒ"))
    ? `${leakingLines.length} line(s), all from next dev's own log of Server Function arguments (next.config.ts logging.serverFunctions)`
    : `${leakingLines.length} line(s)`,
);
check("...nor in this script's output", !holds(printed.join("\n")));

const failures = results.filter((ok) => !ok).length;
console.log(`\n${failures ? `${failures} check(s) FAILED` : "All checks passed"} (${results.length} checks).`);
console.log(`The app's output is in ${serverLogPath}`);
process.exit(failures ? 1 : 0);
