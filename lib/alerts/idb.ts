// The alerts' copy of what the service worker needs, in IndexedDB, because
// a service worker can't read localStorage. Database "icepik-alerts", one
// object store, one record per key (types below). It stays on this device.
//
// Opening a database creates it, so:
//   - reads never create it: a read of a database that doesn't exist yet
//     aborts the upgrade and returns nothing;
//   - only writes create it, and page code writes only from the Alerts
//     screen's flow (lib/alerts/client.ts) or while alerts are on.
// Every call opens a connection, uses it and closes it, and a connection
// closes itself on "versionchange", so deleteDatabase is never blocked.
// public/sw.js has its own copy of this logic (it can't import): keep the
// names in step.

import type { ServiceWorkerTexts } from "./strings";

export const ALERTS_DB = "icepik-alerts";
const STORE = "copy";
const VERSION = 1;

export type AlertsCopy = {
  // What the notifications need from the settings.
  settings: { distanceMiles: number; lastLocation: boolean; showDetails: boolean };
  // Watched places only, with their labels (Home, Work, a custom name).
  places: { label: string; lat: number; lng: number }[];
  // Where ICEPik was last opened (rounded to 0.001°), or null. No time.
  last: { lat: number; lng: number } | null;
  // This phone's subscription on the server. endpoint: the one the server
  // last confirmed, to notice when the browser changes it.
  device: { id: string; secret: string; vapidKey: string; endpoint: string };
  // Squares not yet confirmed by the server, or null.
  pending: number[] | null;
  // A tapped notification's sighting, for the page to open, or null.
  pendingOpen: { id: string; lat: number; lng: number } | null;
  // Set by the service worker when it couldn't hand the server a new endpoint.
  needsRenew: boolean;
  texts: ServiceWorkerTexts;
};
export type AlertsKey = keyof AlertsCopy;

function supported() {
  return typeof indexedDB !== "undefined";
}

function open(create: boolean): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ALERTS_DB, VERSION);
    let aborted = false;
    request.onupgradeneeded = (event) => {
      if (!create && event.oldVersion === 0) {
        // It didn't exist: don't create it just to read nothing.
        aborted = true;
        request.transaction?.abort();
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

function done(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

// The stored values of these keys (undefined where none). Never creates the
// database.
export async function readCopy<K extends AlertsKey>(keys: K[]): Promise<Partial<Pick<AlertsCopy, K>>> {
  if (!supported()) return {};
  const db = await open(false);
  if (!db) return {};
  try {
    const transaction = db.transaction(STORE, "readonly");
    const store = transaction.objectStore(STORE);
    const out: Partial<Pick<AlertsCopy, K>> = {};
    for (const key of keys) {
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result !== undefined) out[key] = request.result;
      };
    }
    await done(transaction);
    return out;
  } finally {
    db.close();
  }
}

export async function readOne<K extends AlertsKey>(key: K): Promise<AlertsCopy[K] | undefined> {
  return (await readCopy([key]))[key];
}

// Writes these keys in one transaction; undefined deletes a key. Creates the
// database if needed.
export async function writeCopy(values: { [K in AlertsKey]?: AlertsCopy[K] | undefined }) {
  if (!supported()) throw new Error("unsupported");
  const db = await open(true);
  if (!db) throw new Error("unavailable");
  try {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) store.delete(key);
      else store.put(value, key);
    }
    await done(transaction);
  } finally {
    db.close();
  }
}

// Reads a key and clears it, in one transaction. Never creates the database.
export async function takeOne<K extends AlertsKey>(key: K): Promise<AlertsCopy[K] | undefined> {
  if (!supported()) return undefined;
  const db = await open(false);
  if (!db) return undefined;
  try {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    let value: AlertsCopy[K] | undefined;
    const request = store.get(key);
    request.onsuccess = () => {
      value = request.result ?? undefined;
      if (value !== undefined) store.delete(key);
    };
    await done(transaction);
    return value;
  } finally {
    db.close();
  }
}

// Deletes the whole database. Resolves once it's gone (or never existed).
export function deleteCopy(): Promise<void> {
  if (!supported()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(ALERTS_DB);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    // Other connections close on versionchange, so this only waits.
  });
}
