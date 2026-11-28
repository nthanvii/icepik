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

  // --- The Alerts screen (app/_components/alerts-settings.tsx).
  screenTitle: { text: "Alerts", note: "Heading of the Alerts screen and the label of its Settings section. Short." },
  entryIntro: {
    text: "Get a notification when a sighting is reported near your saved places. Optional.",
    note: "Settings main screen, under the Alerts heading. Two lines.",
  },
  entryOn: { text: "Alerts are on.", note: "Settings main screen: status line under the Alerts entry. One line." },
  entryOff: { text: "Alerts are off.", note: "Settings main screen: status line under the Alerts entry. One line." },
  entryButton: { text: "Alerts", note: "Button on the Settings main screen that opens the Alerts screen. One word." },
  back: { text: "Back", note: "Button that leaves the Alerts screen." },
  distanceLegend: { text: "Alert distance", note: "Legend of the distance radio group. Short." },
  distanceOption: { text: "{n} mi", note: "One option of the distance group: 1, 2 or 5. Short." },
  distanceNote: {
    text: "Some alerts may come from a little farther away than the distance you choose.",
    note: "Under the distance group. Two lines.",
  },
  nearMeLabel: { text: "Show sightings near me while ICEPik is open", note: "Label of the in-app notice switch. Up to two lines." },
  nearMeHint: {
    text: "Shows a notice in ICEPik for new sightings within your alert distance of where you are. Nothing is sent anywhere.",
    note: "Hint under the in-app notice switch. Three lines.",
  },
  notConfigured: { text: "Alerts aren't set up yet.", note: "Shown when the app has no VAPID key. One line." },
  installIntro: {
    text: "On an iPhone or iPad, alerts work from the Home Screen app. To set that up:",
    note: "Intro of the numbered install steps (iOS, outside the Home Screen app).",
  },
  installStep1: { text: "Tap the Share button in Safari.", note: "Install step 1. One line." },
  installStep2: { text: "Tap Add to Home Screen.", note: "Install step 2. One line." },
  installStep3: {
    text: "Open ICEPik from your Home Screen, then come back to Settings and Alerts.",
    note: "Install step 3. Two lines.",
  },
  iosTooOld: { text: "Alerts need iOS 16.4 or later.", note: "Shown in the Home Screen app on an older iOS. One line." },
  unsupported: { text: "This browser can't show ICEPik alerts.", note: "Shown when the browser lacks push. One line." },
  blockedHelp: {
    text: "Notifications are blocked for ICEPik. To allow them, open your browser's or phone's settings for this site, set Notifications to Allow, then come back here.",
    note: "Shown when notification permission is denied. Three lines.",
  },
  placesHeading: { text: "Places to watch", note: "Heading above the place switches." },
  placeNotSet: { text: "Not set", note: "Under an unset Home or Work switch. Short." },
  noSavedPlaces: {
    text: "You haven't saved any places yet. Set Home or Work from Saved places in Settings, or save a place from the map: search for it and tap the star.",
    note: "Under the place switches when no place is saved. Three lines.",
  },
  placesHint: {
    text: "Choose up to 5 places to get alerts for.",
    note: "Under the heading of the place switches.",
  },
  whatAlertsDo: {
    text: "ICEPik can send a notification when a sighting is reported near the places you choose, even when the app is closed. Alerts stop if you don't open ICEPik for 30 days.",
    note: "Alerts off: first paragraph, before the warning. Four lines.",
  },
  warningHeading: { text: "Before you turn on alerts", note: "Heading of the location warning." },
  warning1: {
    text: "To send you alerts, ICEPik's server keeps two things: a list of map squares, each about 2.2 km (1.4 miles) across, around the places you choose; and the address that Apple, Google, Mozilla or Microsoft uses to deliver alerts to this phone. It keeps no ICEPik account and no exact places. Your places stay on this phone, but the list shows which square each one is in.",
    note: "Warning paragraph 1. Long page text.",
  },
  warning2: {
    text: "Anyone who gets this list, for example through a data breach or a legal demand, could see which areas this phone gets alerts for. With the push company's records, they could also find out whose phone it is.",
    note: "Warning paragraph 2. Long page text.",
  },
  warning3: {
    text: "The push company knows which phone, and usually which account, each alert goes to. It can't read your alerts, but it sees when they arrive. Sightings on the map are public, so the times of your alerts could show that company, or anyone it gives its records to, roughly which areas you get alerts for.",
    note: "Warning paragraph 3. Long page text.",
  },
  warning4: {
    text: "Alerts appear on your lock screen. Unless you choose to show them, they don't name your places or say how far away a sighting is. But anyone who sees your phone can see that you use ICEPik and when alerts arrived, and those times can be matched with the public map.",
    note: "Warning paragraph 4. Long page text.",
  },
  warning5: {
    text: "You can turn alerts off at any time. If your phone is online, that deletes the list from the server right away. If not, the server deletes it about 30 days after you last opened ICEPik.",
    note: "Warning paragraph 5. Long page text.",
  },
  warning6: {
    text: "If being linked to these areas could put you or someone else in danger, leave alerts off. ICEPik can still show sightings near you while it's open.",
    note: "Warning paragraph 6. Long page text.",
  },
  understoodLabel: {
    text: "I understand that alerts can reveal roughly which areas I get alerts for.",
    note: "Label of the warning's checkbox. Up to three lines.",
  },
  turnOn: { text: "Turn on alerts", note: "Primary button. Short." },
  turningOn: { text: "Turning on…", note: "Label of the button while the request runs." },
  needsLead: { text: "Still needed:", note: "Start of the line next to the button listing what's missing." },
  needPlaceItem: { text: "switch on a place", note: "Item in the still-needed list." },
  needBoxItem: { text: "tick the box", note: "Item in the still-needed list." },
  needCheckItem: { text: "wait for the security check", note: "Item in the still-needed list." },
  needReadyItem: { text: "wait while alerts get ready", note: "Item in the still-needed list." },
  readyToTurnOn: { text: "Ready to turn on.", note: "Line next to the button when nothing is missing." },
  captchaFailed: {
    text: "The security check couldn't run. Check your connection and try again.",
    note: "Shown when the Turnstile widget fails.",
  },
  captchaWait: { text: "Wait for the security check to finish, then tap again.", note: "Refusal: tapped before the token arrived." },
  alertsAreOn: { text: "Alerts are on", note: "Heading of the on state. Short." },
  thirtyDays: {
    text: "Alerts stop if you don't open ICEPik for 30 days. Opening it renews them.",
    note: "Line under the on heading.",
  },
  turnOff: { text: "Turn off alerts", note: "Button that turns alerts off. Short." },
  turningOff: { text: "Turning off…", note: "Label while turning off." },
  turnedOff: { text: "Alerts are off.", note: "Result after turning alerts off, in the live region." },
  detailsLabel: { text: "Show place and distance in alerts", note: "Label of the details switch. Up to two lines." },
  detailsHint: {
    text: "Anyone who sees your phone, even when it's locked, can then see your place's name and how far away the sighting was.",
    note: "Hint under the details switch. Three lines.",
  },
  lastLabel: { text: "Also alert near where I last opened ICEPik", note: "Label of the last-opened switch. Up to two lines." },
  lastHint: {
    text: "Alerts for sightings near the spot where you most recently opened ICEPik, not only your saved places.",
    note: "Hint under the last-opened switch. Three lines.",
  },
  lastNoLocation: {
    text: "Location isn't allowed for ICEPik, so there is no spot to watch yet. Allow location in your browser, then open ICEPik again.",
    note: "Note under the last-opened switch when location isn't allowed. Three lines.",
  },
  lastHeading: { text: "Alerts near where you last opened ICEPik", note: "Heading of the last-opened warning." },
  lastWarning: {
    text: "Each time you open ICEPik, the squares around where you are replace the last ones on the server. That could be your home, your work or anywhere else you open the app. The server keeps only the latest squares, but the push company sees when your alerts arrive, so over time it could learn roughly where you tend to open ICEPik.",
    note: "Warning before the last-opened option turns on. Five lines.",
  },
  lastConfirm: { text: "Turn on", note: "Confirm button of the last-opened warning." },
  lastCancel: { text: "Cancel", note: "Cancel button of the last-opened warning." },
  reasonBlocked: {
    text: "Alerts were turned off because notifications for ICEPik were blocked.",
    note: "Alerts screen, off state, after notifications were blocked.",
  },
  reasonExpired: {
    text: "Alerts were turned off because this phone's subscription ended. You can turn them on again here.",
    note: "Alerts screen, off state, after the server forgot this phone.",
  },
  reasonNoPlaces: {
    text: "Alerts were turned off because no places are left to watch. Switch on a place to turn them on again.",
    note: "Alerts screen, off state, after the last watched place was removed.",
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
