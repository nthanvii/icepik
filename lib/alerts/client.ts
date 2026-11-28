// Push alerts on the phone: what the Alerts screen and the map call.
//
//   alertSupport()                  what this browser can do
//   prepareAlerts() / releaseAlerts()  when the Alerts screen opens / closes
//   enableAlerts(token, understood) straight from the "Turn on alerts" tap
//   disableAlerts(reason?)          turning off, Clear this device, deleting the account
//   updateAlertSettings(patch)      every change on the Alerts screen
//   refreshAlerts()                 each time ICEPik opens (lib/alerts/upkeep.ts)
//   useAlertSettings()              the settings, plus why alerts went off
//
// The server keeps only the ~2.2 km squares around the watched places
// (lib/push-cells.ts) and the push subscription, with no account
// (app/actions/push.ts). Every change to what is watched has to reach it,
// because the phone can't hide a push: see "Keep the server in step" in
// docs/database-handoff.md. Until the server confirms a change, its squares
// wait in the IndexedDB copy ("pending") and are sent again on the next open
// or when the network is back. Every call sends the current squares.
//
// Nothing here is ever logged: the inputs hold places, the push endpoint and
// the device secret.

import { useMemo, useSyncExternalStore } from "react";
import { createPushSubscription, deletePushSubscription, updatePushSubscription } from "@/app/actions/push";
import {
  readAlertSettings,
  readCustomPlaces,
  readSavedPlaces,
  saveAlertSettings,
  useStoredAlertSettings,
  type AlertSettings,
} from "@/lib/device-storage";
import { cellsAround, MAX_ALERT_CELLS, MAX_ALERT_PLACES } from "@/lib/push-cells";
import { deleteCopy, readCopy, readOne, takeOne, writeCopy, type AlertsCopy } from "./idb";
import { alertText, METERS_PER_MILE, serviceWorkerTexts, type AlertStringKey } from "./strings";

export type AlertSupport = "not-configured" | "install-ios" | "ios-too-old" | "blocked" | "unsupported" | "ok";
export type TurnedOffReason = null | "blocked" | "expired" | "no-places";
export type AlertResult = { ok: true; message: string } | { ok: false; message: string };
// What a refresh or a sync came to.
export type SyncOutcome = "off" | "ok" | "failed" | "blocked" | "expired" | "no-places";
export type WatchedPlace = { id: string; label: string; lat: number; lng: number };

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() ?? "";
const SYNC_DELAY_MS = 1000;
const ACTIVATE_TIMEOUT_MS = 15000;
// Turning off waits this long for the server's delete, then goes on: Clear
// this device must finish on a stalled network too.
const DELETE_TIMEOUT_MS = 10000;
// The labels of Home and Work, as everywhere else in the app.
const PLACE_LABELS: Record<string, string> = { home: "Home", work: "Work" };

// --- What the browser can do -----------------------------------------------

function isIos() {
  const ua = navigator.userAgent;
  // iPadOS asks for desktop sites and says it's a Mac; only iPads have touch.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

export function alertSupport(): AlertSupport {
  if (!VAPID_PUBLIC_KEY) return "not-configured";
  if (typeof window === "undefined") return "unsupported";
  const pushManager = "PushManager" in window;
  // iPhones and iPads get push only in the Home Screen app, on iOS 16.4+.
  if (isIos() && !pushManager) return isStandalone() ? "ios-too-old" : "install-ios";
  if (!("serviceWorker" in navigator) || !pushManager || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return "ok";
}

// --- Why alerts went off (memory only, for this page load) -----------------

let reason: TurnedOffReason = null;
const reasonListeners = new Set<() => void>();
function setReason(next: TurnedOffReason) {
  reason = next;
  reasonListeners.forEach((listener) => listener());
}
function subscribeReason(listener: () => void) {
  reasonListeners.add(listener);
  return () => void reasonListeners.delete(listener);
}

export function useAlertSettings(): AlertSettings & { turnedOffReason: TurnedOffReason } {
  const settings = useStoredAlertSettings();
  const turnedOffReason = useSyncExternalStore(
    subscribeReason,
    () => reason,
    () => null,
  );
  return useMemo(() => ({ ...settings, turnedOffReason }), [settings, turnedOffReason]);
}

// --- Places and squares ------------------------------------------------------

// The watched places that exist on this device, in the order of placeIds.
export function watchedPlaces(settings: AlertSettings): WatchedPlace[] {
  const saved = readSavedPlaces();
  const custom = readCustomPlaces();
  const out: WatchedPlace[] = [];
  for (const id of settings.placeIds) {
    if (id === "home" || id === "work") {
      const place = saved[id];
      if (place) out.push({ id, label: PLACE_LABELS[id], lat: place.lat, lng: place.lng });
    } else {
      const place = custom.find((p) => p.id === id);
      if (place) out.push({ id, label: place.name, lat: place.lat, lng: place.lng });
    }
  }
  return out;
}

// Every square around the watched places and the last-opened spot, as one
// sorted list without repeats.
export function alertCells(
  places: { lat: number; lng: number }[],
  last: { lat: number; lng: number } | null,
  distanceMiles: number,
): number[] {
  const radius = distanceMiles * METERS_PER_MILE;
  const cells = new Set<number>();
  for (const spot of last ? [...places, last] : places) {
    for (const cell of cellsAround(spot.lat, spot.lng, radius)) cells.add(cell);
  }
  return [...cells].sort((a, b) => a - b);
}

const sameCells = (a: number[] | null | undefined, b: number[] | null | undefined) =>
  Boolean(a && b && a.length === b.length && a.every((cell, i) => cell === b[i]));

function copySettings(settings: AlertSettings): AlertsCopy["settings"] {
  return {
    distanceMiles: settings.distanceMiles,
    lastLocation: settings.lastLocation,
    showDetails: settings.showDetails,
  };
}

function copyPlaces(places: WatchedPlace[]): AlertsCopy["places"] {
  return places.map(({ label, lat, lng }) => ({ label, lat, lng }));
}

// --- The service worker ------------------------------------------------------

let registration: ServiceWorkerRegistration | null = null;

function waitActive(reg: ServiceWorkerRegistration) {
  return new Promise<void>((resolve, reject) => {
    if (reg.active) return resolve();
    const worker = reg.installing ?? reg.waiting;
    if (!worker) return reject(new Error("no worker"));
    const timer = window.setTimeout(() => reject(new Error("timeout")), ACTIVATE_TIMEOUT_MS);
    const check = () => {
      if (worker.state === "activated" || reg.active) {
        window.clearTimeout(timer);
        worker.removeEventListener("statechange", check);
        resolve();
      } else if (worker.state === "redundant") {
        window.clearTimeout(timer);
        worker.removeEventListener("statechange", check);
        reject(new Error("redundant"));
      }
    };
    worker.addEventListener("statechange", check);
    check();
  });
}

// Registers /sw.js (idempotent) and waits until it's active.
async function registerWorker() {
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  await waitActive(reg);
  registration = reg;
  return reg;
}

async function currentRegistration() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return undefined;
  return navigator.serviceWorker.getRegistration("/");
}

function base64UrlToBytes(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// 32 random bytes in base64url, without padding (app/actions/push.ts).
function newSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function quietly(step: () => Promise<unknown> | undefined) {
  try {
    await step();
  } catch {
    // Each step of an undo or a teardown runs even if another failed.
  }
}

const refuse = (key: AlertStringKey): Promise<AlertResult> =>
  Promise.resolve({ ok: false, message: alertText(key) });

// --- The Alerts screen opens and closes ---------------------------------------

let enabling: Promise<AlertResult> | null = null;

// When the Alerts screen opens (on /, after consent): the worker has to be
// active before the tap, because the tap must subscribe at once. A
// subscription the browser holds without a stored device (left by an earlier
// attempt) is removed now, so the tap makes a fresh one. True when ready.
export async function prepareAlerts(): Promise<boolean> {
  if (alertSupport() !== "ok") return false;
  try {
    const reg = await registerWorker();
    const subscription = await reg.pushManager.getSubscription();
    if (subscription) {
      const device = await readOne("device");
      if (!device || !readAlertSettings().on) await subscription.unsubscribe();
    }
    return true;
  } catch {
    return false;
  }
}

// When the Alerts screen closes: with alerts off, nothing of them stays.
export async function releaseAlerts() {
  if (enabling) await enabling.catch(() => undefined);
  if (readAlertSettings().on) return;
  const reg = await currentRegistration().catch(() => undefined);
  await quietly(async () => (await reg?.pushManager.getSubscription())?.unsubscribe());
  await quietly(() => deleteCopy());
  await quietly(() => reg?.unregister());
  registration = null;
}

// --- Turning alerts on -------------------------------------------------------

let lastRefreshAt = 0;

// Call this straight from the button's click handler: on iPhones,
// pushManager.subscribe() must run in the tap itself, before anything that
// waits. So the checks here are synchronous, and subscribe() comes first;
// the Turnstile check (inside createPushSubscription) comes after it.
// captchaToken: the widget's token, or "" when the check is off locally.
// understood: the warning's box is ticked.
export function enableAlerts(captchaToken: string | null, understood: boolean): Promise<AlertResult> {
  if (!understood) return refuse("needUnderstood");
  const settings = readAlertSettings();
  const places = watchedPlaces(settings);
  if (places.length === 0) return refuse("needPlace");
  if (places.length > MAX_ALERT_PLACES) return refuse("tooManyPlaces");
  const cells = alertCells(places, null, settings.distanceMiles);
  if (cells.length > MAX_ALERT_CELLS) return refuse("tooManyCells");
  const reg = registration;
  if (!reg?.active || !VAPID_PUBLIC_KEY) return refuse("notReady");

  let subscribing: Promise<PushSubscription>;
  try {
    // Also asks for notification permission.
    subscribing = reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(VAPID_PUBLIC_KEY),
    });
  } catch {
    return refuse("subscribeFailed");
  }
  const run = finishEnabling(subscribing, cells, places, captchaToken ?? "");
  enabling = run;
  void run.finally(() => {
    if (enabling === run) enabling = null;
  });
  return run;
}

async function finishEnabling(
  subscribing: Promise<PushSubscription>,
  cells: number[],
  places: WatchedPlace[],
  captchaToken: string,
): Promise<AlertResult> {
  let subscription: PushSubscription;
  try {
    subscription = await subscribing;
  } catch (error) {
    const refused =
      (typeof Notification !== "undefined" && Notification.permission !== "granted") ||
      (error instanceof DOMException && error.name === "NotAllowedError");
    return { ok: false, message: alertText(refused ? "notAllowed" : "subscribeFailed") };
  }

  const json = subscription.toJSON();
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    await quietly(() => subscription.unsubscribe());
    return { ok: false, message: alertText("subscribeFailed") };
  }

  const secret = newSecret();
  let created: Awaited<ReturnType<typeof createPushSubscription>>;
  try {
    created = await createPushSubscription({ endpoint, p256dh, auth, cells, secret, captchaToken });
  } catch {
    await quietly(() => subscription.unsubscribe());
    return { ok: false, message: alertText("networkFailed") };
  }
  if (!created.ok) {
    // endpoint_taken: the server still has this browser's old subscription.
    // Dropping it here makes the next tap subscribe afresh (the old row ends
    // when its push service answers 410).
    await quietly(() => subscription.unsubscribe());
    return { ok: false, message: created.error === "endpoint_taken" ? alertText("tapAgain") : created.message };
  }

  const device = { id: created.data.id, secret, vapidKey: VAPID_PUBLIC_KEY, endpoint };
  const undo = async () => {
    await quietly(() => deletePushSubscription({ id: device.id, secret }));
    await quietly(() => subscription.unsubscribe());
    await quietly(() => deleteCopy());
  };
  try {
    const settings = readAlertSettings();
    await deleteCopy();
    await writeCopy({
      device,
      settings: copySettings(settings),
      places: copyPlaces(places),
      needsRenew: false,
      texts: serviceWorkerTexts(),
    });
    if (!saveAlertSettings({ ...settings, on: true })) throw new Error("storage");
  } catch {
    await undo();
    return { ok: false, message: alertText("saveFailed") };
  }
  lastRefreshAt = Date.now();
  setReason(null);
  return { ok: true, message: alertText("turnedOn") };
}

// --- Turning alerts off ------------------------------------------------------

// Delete on the server, then unsubscribe even if that failed (the push
// service then answers 410 and the sender drops the row), then delete the
// copy and unregister the worker. Every step runs; it never throws.
export async function disableAlerts(why: TurnedOffReason = null): Promise<void> {
  window.clearTimeout(syncTimer);
  let device: AlertsCopy["device"] | undefined;
  await quietly(async () => {
    device = await readOne("device");
  });
  if (device) {
    const { id, secret } = device;
    await quietly(() =>
      Promise.race([
        deletePushSubscription({ id, secret }),
        new Promise((_, reject) => window.setTimeout(() => reject(new Error("timeout")), DELETE_TIMEOUT_MS)),
      ]),
    );
  }
  const reg = await currentRegistration().catch(() => undefined);
  await quietly(async () => (await reg?.pushManager.getSubscription())?.unsubscribe());
  await quietly(() => deleteCopy());
  await quietly(() => reg?.unregister());
  registration = null;
  await quietly(async () => {
    const settings = readAlertSettings();
    if (settings.on) saveAlertSettings({ ...settings, on: false });
  });
  setReason(why);
}

// --- Keeping the server in step ----------------------------------------------

let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(step: () => Promise<T>): Promise<T> {
  const run = chain.then(step, step);
  chain = run.catch(() => undefined);
  return run;
}

let syncTimer: number | undefined;
function scheduleSync() {
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => void syncServer(null), SYNC_DELAY_MS);
}

// Sends the current squares (and a new endpoint, when the browser changed
// it or the worker couldn't hand it over). This also renews the 30 days.
function syncServer(subscription: PushSubscription | null): Promise<SyncOutcome> {
  return serialize(async (): Promise<SyncOutcome> => {
    const settings = readAlertSettings();
    if (!settings.on) return "off";
    let copy: Partial<Pick<AlertsCopy, "device" | "last" | "needsRenew">>;
    try {
      copy = await readCopy(["device", "last", "needsRenew"]);
    } catch {
      return "failed";
    }
    const device = copy.device;
    if (!device) {
      // The copy is gone (cleared outside ICEPik): the server row can't be
      // reached any more, and it ends by itself within 30 days.
      await disableAlerts("expired");
      return "expired";
    }
    const places = watchedPlaces(settings);
    const last = settings.lastLocation ? (copy.last ?? null) : null;
    if (places.length === 0 && !last) {
      await disableAlerts("no-places");
      return "no-places";
    }
    const cells = alertCells(places, last, settings.distanceMiles);

    const update: Parameters<typeof updatePushSubscription>[0] = { id: device.id, secret: device.secret, cells };
    let newEndpoint: string | null = null;
    if (subscription) {
      const json = subscription.toJSON();
      const { p256dh, auth } = json.keys ?? {};
      if (json.endpoint && p256dh && auth && (json.endpoint !== device.endpoint || copy.needsRenew)) {
        Object.assign(update, { endpoint: json.endpoint, p256dh, auth });
        newEndpoint = json.endpoint;
      }
    }
    await quietly(() =>
      writeCopy({
        pending: cells,
        settings: copySettings(settings),
        places: copyPlaces(places),
        texts: serviceWorkerTexts(),
      }),
    );
    if (cells.length > MAX_ALERT_CELLS) return "failed";

    let result: Awaited<ReturnType<typeof updatePushSubscription>>;
    try {
      result = await updatePushSubscription(update);
    } catch {
      // Offline, or the server didn't answer: still pending.
      return "failed";
    }
    if (result.ok) {
      await quietly(async () => {
        const pending = await readOne("pending");
        await writeCopy({
          ...(sameCells(pending, cells) ? { pending: undefined } : {}),
          ...(newEndpoint ? { device: { ...device, endpoint: newEndpoint }, needsRenew: false } : {}),
        });
      });
      return "ok";
    }
    if (result.error === "not_found") {
      await disableAlerts("expired");
      return "expired";
    }
    return "failed";
  });
}

// Each time ICEPik opens on / (and when it comes back after an hour), while
// alerts are on: register the worker again, check permission and the
// subscription, and send the current squares.
export async function refreshAlerts(): Promise<SyncOutcome> {
  if (!readAlertSettings().on) return "off";
  lastRefreshAt = Date.now();
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window) ||
    Notification.permission !== "granted"
  ) {
    await disableAlerts("blocked");
    return "blocked";
  }
  let subscription: PushSubscription | null;
  try {
    const reg = await registerWorker();
    subscription = await reg.pushManager.getSubscription();
  } catch {
    return "failed";
  }
  if (!subscription) {
    await disableAlerts("blocked");
    return "blocked";
  }
  return syncServer(subscription);
}

export function msSinceRefresh() {
  return Date.now() - lastRefreshAt;
}

// When the network is back: send a change the server hasn't confirmed.
export async function retryPending(): Promise<SyncOutcome> {
  if (!readAlertSettings().on) return "off";
  const pending = await readOne("pending").catch(() => undefined);
  return pending ? syncServer(null) : "ok";
}

// Saved places were added, moved, renamed or removed (on /). Drops watched
// ids whose place is gone, refreshes the copy and sends the squares.
export async function syncPlaces(): Promise<SyncOutcome> {
  const settings = readAlertSettings();
  if (!settings.on) return "off";
  const places = watchedPlaces(settings);
  const kept = places.map((place) => place.id);
  if (kept.length !== settings.placeIds.length) saveAlertSettings({ ...settings, placeIds: kept });
  return syncServer(null);
}

// The first position after ICEPik opened, for the last-opened option. Kept
// to 0.001° on this device; only its squares reach the server.
export async function recordLastSpot(position: { lat: number; lng: number }): Promise<SyncOutcome> {
  const settings = readAlertSettings();
  if (!settings.on || !settings.lastLocation) return "off";
  const last = { lat: Math.round(position.lat * 1000) / 1000, lng: Math.round(position.lng * 1000) / 1000 };
  try {
    await writeCopy({ last });
  } catch {
    return "failed";
  }
  return syncServer(null);
}

// The sighting a tapped notification asked for, read once.
export async function takePendingOpen() {
  try {
    return (await takeOne("pendingOpen")) ?? null;
  } catch {
    return null;
  }
}

// Every change on the Alerts screen. Saved here at once; while alerts are
// on, the copy is refreshed and the squares are sent about 1 s later.
// A refused change keeps the old settings.
export async function updateAlertSettings(patch: Partial<Omit<AlertSettings, "on">>): Promise<AlertResult> {
  const current = readAlertSettings();
  const next: AlertSettings = { ...current, ...patch, on: current.on };
  if (patch.placeIds) {
    const ids = [...new Set(patch.placeIds)];
    if (ids.length > MAX_ALERT_PLACES) return refuse("tooManyPlaces");
    // A place that isn't set can't be watched.
    next.placeIds = watchedPlaces({ ...next, placeIds: ids }).map((place) => place.id);
  }

  const places = watchedPlaces(next);
  let last: AlertsCopy["last"] = null;
  if (current.on && next.lastLocation) {
    last = (await readOne("last").catch(() => undefined)) ?? null;
  }
  if (current.on && places.length === 0 && !last) return refuse("keepOnePlace");
  const cells = alertCells(places, last, next.distanceMiles);
  if (cells.length > MAX_ALERT_CELLS) return refuse("tooManyCells");

  let before: number[] | null = null;
  if (current.on) {
    const oldLast = current.lastLocation ? last ?? (await readOne("last").catch(() => undefined)) ?? null : null;
    before = alertCells(watchedPlaces(current), oldLast, current.distanceMiles);
  }
  if (!saveAlertSettings(next)) return refuse("saveFailed");
  if (!current.on) return { ok: true, message: "" };

  try {
    await writeCopy({
      settings: copySettings(next),
      places: copyPlaces(places),
      texts: serviceWorkerTexts(),
      // Turning the last-opened option off forgets the spot.
      ...(next.lastLocation ? {} : { last: undefined }),
      ...(sameCells(before, cells) ? {} : { pending: cells }),
    });
  } catch {
    // The squares are still sent; the notifications use the old copy.
  }
  if (!sameCells(before, cells)) scheduleSync();
  return { ok: true, message: "" };
}

// Test hooks for scripts/alerts-flows.mjs, in `next dev` only: the
// production build drops this block.
if (process.env.NODE_ENV === "development" && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__icepikAlerts = {
    alertSupport,
    alertCells,
    prepareAlerts,
    releaseAlerts,
    enableAlerts,
    disableAlerts,
    updateAlertSettings,
    refreshAlerts,
    retryPending,
    syncPlaces,
    recordLastSpot,
  };
}
