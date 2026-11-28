// Every user-facing text of push alerts, one entry per text. English only for
// now. Each entry says where it appears and how much room it has.
//
// {category}, {distance}, {place} and {limit} are filled in where the text
// is used. The service worker (public/sw.js) can't import this file: the page
// writes serviceWorkerTexts() into the alerts' IndexedDB copy
// (lib/alerts/idb.ts), and sw.js keeps an English copy as its fallback. Keep
// the two in step.

type Entry = { text: string; note: string };

export const ALERT_STRINGS = {
  // --- Notifications (public/sw.js). A lock screen shows about 40
  // characters of a title and two lines of a body, so keep them short.
  privateTitle: {
    text: "{category} reported near one of your places",
    note: "Notification title, the default (details switch off). Same words inside or beyond the alert distance. About 45 characters.",
  },
  privateBody: {
    text: "Open ICEPik to see where.",
    note: "Notification body, the default. One line.",
  },
  detailTitle: {
    text: "{category} {distance} from {place}",
    note: "Notification title with “Show place and distance in alerts” on. {place} is Home, Work, a custom place's name (up to 40 characters) or lastPlace. Can wrap or be cut on a lock screen.",
  },
  detailBodyNear: {
    text: "Open ICEPik to see it on the map.",
    note: "Notification body with details on, sighting within the alert distance. One line.",
  },
  detailBodyFar: {
    text: "Farther than your {limit} mi alert distance.",
    note: "Notification body with details on, sighting beyond the alert distance ({limit} is 1, 2 or 5). One line.",
  },
  noPlaceTitle: {
    text: "{category} reported",
    note: "Notification title when this phone has no watched place stored. Short.",
  },
  noPlaceBody: {
    text: "Open ICEPik for details.",
    note: "Notification body when no watched place is stored. One line.",
  },
  brokenTitle: {
    text: "New ICEPik alert",
    note: "Notification title when the push message is empty or can't be read. No body.",
  },
  lastPlace: {
    text: "where you last opened ICEPik",
    note: "{place} in detailTitle, when the nearest watched spot is the last-opened one. About 30 characters.",
  },
  distanceMiles: {
    text: "{n} mi",
    note: "{distance} in detailTitle and inAppNotice: miles with one decimal, at least 0.1. Short.",
  },
  fallbackCategory: {
    text: "Sighting",
    note: "{category} for “Other” or an unknown category, in notifications and inAppNotice. One word.",
  },

  // --- In-app notice (map-app.tsx's notice, while ICEPik is open on /).
  inAppNotice: {
    text: "New sighting near you: {category}, {distance} away.",
    note: "The notice shown while ICEPik is open, for a new sighting within the alert distance of the live position. Notices hold about 3 lines on phones.",
  },
  sightingGone: {
    text: "That sighting is no longer on the map.",
    note: "Notice after tapping an alert whose sighting has expired or was deleted; the map centres on its point. One or two lines.",
  },
  stoppedExpired: {
    text: "Alerts stopped because this phone's subscription ended. You can turn them on again in Settings.",
    note: "Notice when the server no longer has this phone's alerts (not_found on open). Two or three lines.",
  },
  stoppedNoPlaces: {
    text: "Alerts are off because no places are left to watch. You can turn them on again in Settings.",
    note: "Notice when the last watched place was removed. Two or three lines.",
  },
  stoppedBlocked: {
    text: "Alerts are off because notifications for ICEPik were blocked.",
    note: "Notice when notification permission was taken away or the browser dropped the subscription. Two lines.",
  },

  // --- Refusals and results from lib/alerts/client.ts, read from a polite
  // live region on the Alerts screen. One or two lines each.
  needUnderstood: {
    text: "Tick the box to confirm you understand the warning.",
    note: "Refusal: Turn on alerts tapped with the warning's box unticked.",
  },
  needPlace: {
    text: "Switch on at least one place first.",
    note: "Refusal: Turn on alerts tapped with no place switched on.",
  },
  tooManyCells: {
    text: "That covers too large an area. Choose a smaller distance or fewer places.",
    note: "Refusal: the squares would exceed the server's limit (MAX_ALERT_CELLS).",
  },
  tooManyPlaces: {
    text: "You can get alerts for up to 5 places.",
    note: "Refusal when a sixth place is switched on; also the line under the disabled switches.",
  },
  keepOnePlace: {
    text: "Keep at least one place, or turn alerts off.",
    note: "Refusal: switching off the last watched place while alerts are on.",
  },
  notReady: {
    text: "Alerts aren't ready yet. Wait a moment and try again.",
    note: "Refusal: the tap came before the service worker was active.",
  },
  notAllowed: {
    text: "Notifications weren't allowed, so alerts can't be turned on.",
    note: "Result: the browser or the person refused notification permission at the tap.",
  },
  subscribeFailed: {
    text: "This browser couldn't set up alerts. Please try again.",
    note: "Result: pushManager.subscribe() failed for another reason.",
  },
  tapAgain: {
    text: "Please tap Turn on alerts again.",
    note: "Result: the browser held an old subscription (endpoint_taken); it was removed, so a second tap works.",
  },
  networkFailed: {
    text: "ICEPik couldn't reach its server. Check your connection and try again.",
    note: "Result: createPushSubscription didn't answer (offline); the subscription was undone.",
  },
  saveFailed: {
    text: "Alerts couldn't be saved on this phone, so they weren't turned on.",
    note: "Result: the IndexedDB copy couldn't be written; everything was undone.",
  },
  turnedOn: {
    text: "Alerts are on.",
    note: "Result after turning alerts on.",
  },
} satisfies Record<string, Entry>;

export type AlertStringKey = keyof typeof ALERT_STRINGS;

// The text of an entry, with its {placeholders} filled in.
export function alertText(key: AlertStringKey, values: Record<string, string | number> = {}) {
  return fill(ALERT_STRINGS[key].text, values);
}

export function fill(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}

// Category labels for alerts: lib/sightings.ts's labels, except "Other",
// which reads badly as "Other reported".
export const ALERT_CATEGORY: Record<string, string> = {
  patrol: "Patrol",
  vehicle: "Vehicle",
  checkpoint: "Checkpoint",
  raid: "Raid",
};

export function alertCategory(category: string) {
  return ALERT_CATEGORY[category] ?? ALERT_STRINGS.fallbackCategory.text;
}

export const METERS_PER_MILE = 1609.344;

// "0.4 mi": miles with one decimal, at least 0.1, as the alert distances are
// in miles.
export function formatMiles(meters: number) {
  const miles = Math.max(0.1, Math.round(meters / METERS_PER_MILE / 0.1) * 0.1);
  return alertText("distanceMiles", { n: miles.toFixed(1) });
}

// What the service worker needs, already in the chosen language, stored in
// IndexedDB as "texts". The version lets sw.js ignore a copy it can't read.
export type ServiceWorkerTexts = {
  v: 1;
  categories: Record<string, string>;
  fallbackCategory: string;
  privateTitle: string;
  privateBody: string;
  detailTitle: string;
  detailBodyNear: string;
  detailBodyFar: string;
  noPlaceTitle: string;
  noPlaceBody: string;
  brokenTitle: string;
  lastPlace: string;
  distanceMiles: string;
};

export function serviceWorkerTexts(): ServiceWorkerTexts {
  const t = (key: AlertStringKey) => ALERT_STRINGS[key].text;
  return {
    v: 1,
    categories: { ...ALERT_CATEGORY },
    fallbackCategory: t("fallbackCategory"),
    privateTitle: t("privateTitle"),
    privateBody: t("privateBody"),
    detailTitle: t("detailTitle"),
    detailBodyNear: t("detailBodyNear"),
    detailBodyFar: t("detailBodyFar"),
    noPlaceTitle: t("noPlaceTitle"),
    noPlaceBody: t("noPlaceBody"),
    brokenTitle: t("brokenTitle"),
    lastPlace: t("lastPlace"),
    distanceMiles: t("distanceMiles"),
  };
}
