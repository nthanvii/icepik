// ICEPik's service worker, for push alerts only. Plain JavaScript, no
// imports, no fetch handler and no caches: it never sees or stores a page or
// a request. Registered from the Alerts screen (lib/alerts/client.ts).
//
// What it reads comes from the page's copy in IndexedDB ("icepik-alerts",
// see lib/alerts/idb.ts; the names here must match): the settings, the
// watched places, the last-opened spot, the device's id and secret, and the
// notification texts. It never logs anything: a push holds a sighting's id
// and point, and the copy holds places and the device secret.
//
// Every push shows exactly one notification, even when the message can't be
// read: Safari revokes push permission otherwise, and Chrome shows its own.

"use strict";

const DB_NAME = "icepik-alerts";
const STORE = "copy";
const DB_VERSION = 1;
const METERS_PER_MILE = 1609.344;
const ICON = "/icons/icon-192.png";

// English fallback for the texts the page stores (lib/alerts/strings.ts,
// serviceWorkerTexts()). Keep in step.
const FALLBACK_TEXTS = {
  v: 1,
  categories: { patrol: "Patrol", vehicle: "Vehicle", checkpoint: "Checkpoint", raid: "Raid" },
  fallbackCategory: "Sighting",
  privateTitle: "{category} reported near one of your places",
  privateBody: "Open ICEPik to see where.",
  detailTitle: "{category} {distance} from {place}",
  detailBodyNear: "Open ICEPik to see it on the map.",
  detailBodyFar: "Farther than your {limit} mi alert distance.",
  noPlaceTitle: "{category} reported",
  noPlaceBody: "Open ICEPik for details.",
  brokenTitle: "New ICEPik alert",
  lastPlace: "where you last opened ICEPik",
  distanceMiles: "{n} mi",
};

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event.data));
});

self.addEventListener("notificationclick", (event) => {
  event.waitUntil(handleClick(event));
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(handleSubscriptionChange(event));
});

// --- IndexedDB (same rules as lib/alerts/idb.ts) ---------------------------

// Opens the copy. With create false, a database that doesn't exist yet is
// not created (resolves null), so a late push after "turn off" leaves nothing.
function openDb(create) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let aborted = false;
    request.onupgradeneeded = (event) => {
      if (!create && event.oldVersion === 0) {
        aborted = true;
        request.transaction.abort();
        return;
      }
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => (aborted ? resolve(null) : reject(request.error));
    request.onblocked = () => reject(new Error("blocked"));
  });
}

function finished(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function readCopy(keys) {
  const db = await openDb(false);
  if (!db) return {};
  try {
    const transaction = db.transaction(STORE, "readonly");
    const store = transaction.objectStore(STORE);
    const out = {};
    for (const key of keys) {
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result !== undefined) out[key] = request.result;
      };
    }
    await finished(transaction);
    return out;
  } finally {
    db.close();
  }
}

// Writes only into a copy that exists: after "turn off" there is none.
async function writeCopy(values) {
  const db = await openDb(false);
  if (!db) return false;
  try {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    for (const key of Object.keys(values)) store.put(values[key], key);
    await finished(transaction);
    return true;
  } finally {
    db.close();
  }
}

// --- Push --------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The sender's message (supabase/functions/push-sightings/index.ts):
// { v: 1, id, lat, lng, cat, at, pad }, or null if it isn't one.
function parseMessage(data) {
  try {
    if (!data) return null;
    const value = JSON.parse(data.text());
    if (!value || value.v !== 1 || typeof value.id !== "string" || !UUID.test(value.id)) return null;
    const lat = value.lat;
    const lng = value.lng;
    if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    const at = typeof value.at === "string" ? Date.parse(value.at) : NaN;
    return {
      id: value.id,
      lat,
      lng,
      cat: typeof value.cat === "string" ? value.cat : "",
      at: Number.isFinite(at) ? at : null,
    };
  } catch {
    return null;
  }
}

function usableTexts(texts) {
  return texts && texts.v === 1 && typeof texts.privateTitle === "string" ? texts : FALLBACK_TEXTS;
}

function fill(text, values) {
  return String(text).replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
}

// A copy of distanceMeters() in lib/geo.ts (the haversine formula the
// database uses). Keep in step.
function distanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function isPoint(p) {
  return p && typeof p.lat === "number" && typeof p.lng === "number" && Number.isFinite(p.lat) && Number.isFinite(p.lng);
}

// The notification for a message and the stored copy. Never throws for a
// good message: missing pieces fall back to the shorter texts.
function compose(message, copy) {
  const texts = usableTexts(copy.texts);
  const category = (texts.categories && texts.categories[message.cat]) || texts.fallbackCategory;
  const settings = copy.settings || {};
  const spots = [];
  if (Array.isArray(copy.places)) {
    for (const place of copy.places) {
      if (isPoint(place)) spots.push({ label: typeof place.label === "string" ? place.label : "", lat: place.lat, lng: place.lng });
    }
  }
  if (settings.lastLocation && isPoint(copy.last)) {
    spots.push({ label: texts.lastPlace, lat: copy.last.lat, lng: copy.last.lng });
  }

  const options = {
    tag: message.id,
    data: { id: message.id, lat: message.lat, lng: message.lng },
    icon: ICON,
  };
  if (message.at !== null) options.timestamp = message.at;

  if (spots.length === 0) {
    return { title: fill(texts.noPlaceTitle, { category }), options: { ...options, body: texts.noPlaceBody } };
  }
  if (!settings.showDetails) {
    // Private by default: the same words inside or beyond the distance.
    return { title: fill(texts.privateTitle, { category }), options: { ...options, body: texts.privateBody } };
  }

  let nearest = null;
  for (const spot of spots) {
    const meters = distanceMeters(spot.lat, spot.lng, message.lat, message.lng);
    if (!nearest || meters < nearest.meters) nearest = { label: spot.label, meters };
  }
  const limit = typeof settings.distanceMiles === "number" ? settings.distanceMiles : 1;
  const miles = Math.max(0.1, Math.round(nearest.meters / METERS_PER_MILE / 0.1) * 0.1);
  const distance = fill(texts.distanceMiles, { n: miles.toFixed(1) });
  const far = nearest.meters > limit * METERS_PER_MILE;
  return {
    title: fill(texts.detailTitle, { category, distance, place: nearest.label }),
    options: { ...options, body: far ? fill(texts.detailBodyFar, { limit }) : texts.detailBodyNear },
  };
}

async function handlePush(data) {
  const message = parseMessage(data);
  let copy = {};
  try {
    copy = await readCopy(["settings", "places", "last", "texts"]);
  } catch {
    copy = {};
  }

  let note = null;
  if (message) {
    try {
      note = compose(message, copy);
    } catch {
      note = null;
    }
  }
  if (!note) {
    const texts = usableTexts(copy.texts);
    note = { title: texts.brokenTitle, options: { icon: ICON } };
  }

  try {
    await self.registration.showNotification(note.title, note.options);
  } catch {
    // Only if the first call itself was refused: show the plainest one.
    await self.registration.showNotification(FALLBACK_TEXTS.brokenTitle, { icon: ICON });
  }
}

// --- Notification tap --------------------------------------------------------

// Opens ICEPik on the real map, never /demo, with nothing in the URL: the
// sighting to open waits in the copy ("pendingOpen") for the page to read.
async function handleClick(event) {
  event.notification.close();
  const data = event.notification.data;
  if (data && typeof data.id === "string" && UUID.test(data.id) && isPoint(data)) {
    try {
      await writeCopy({ pendingOpen: { id: data.id, lat: data.lat, lng: data.lng } });
    } catch {
      // ICEPik still opens; it just can't go to the sighting.
    }
  }
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const open = windows.find((client) => {
    try {
      return new URL(client.url).pathname === "/";
    } catch {
      return false;
    }
  });
  if (open) {
    try {
      await open.focus();
    } catch {
      // Focus may be refused; the page still gets the message.
    }
    open.postMessage({ type: "open-sighting" });
    return;
  }
  await self.clients.openWindow("/");
}

// --- New endpoint --------------------------------------------------------------

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// The browser replaced (or dropped) the subscription. Hand the server the
// new one through /api/push/renew; if that fails, the page sends it with
// updatePushSubscription the next time ICEPik opens ("needsRenew").
async function handleSubscriptionChange(event) {
  let copy;
  try {
    copy = await readCopy(["device"]);
  } catch {
    return;
  }
  const device = copy.device;
  if (!device || typeof device.id !== "string" || typeof device.secret !== "string") return;

  let subscription = event.newSubscription || null;
  if (!subscription && typeof device.vapidKey === "string") {
    try {
      subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(device.vapidKey),
      });
    } catch {
      subscription = null;
    }
  }

  let renewed = false;
  const json = subscription ? subscription.toJSON() : null;
  if (json && json.endpoint && json.keys && json.keys.p256dh && json.keys.auth) {
    try {
      const response = await fetch("/api/push/renew", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: device.id,
          secret: device.secret,
          endpoint: json.endpoint,
          p256dh: json.keys.p256dh,
          auth: json.keys.auth,
        }),
        credentials: "omit",
        cache: "no-store",
      });
      renewed = response.status === 204;
    } catch {
      renewed = false;
    }
  }

  try {
    if (renewed) await writeCopy({ needsRenew: false, device: { ...device, endpoint: json.endpoint } });
    else await writeCopy({ needsRenew: true });
  } catch {
    // Nothing more to do here; the page checks the subscription on open.
  }
}
