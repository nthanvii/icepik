// Keeps push alerts in step while ICEPik is open on the real map (MapApp,
// after consent, never on /demo):
//   - each open, and on coming back after an hour: refreshAlerts() registers
//     the worker again, checks permission and the subscription, and sends
//     the current squares (which renews the server's 30 days);
//   - back online: sends a change the server hasn't confirmed;
//   - saved places added, moved, renamed or removed: sends the new squares;
//   - the last-opened option: the first position within 30 s of opening (or
//     of turning the option on) becomes the last-opened spot. It never asks
//     for location: it uses a position the map already has;
//   - a tapped notification: hands its sighting to the map once;
//   - alerts that went off by themselves: a notice says why.

import { useEffect, useEffectEvent, useRef } from "react";
import type { CustomPlace, SavedPlaces } from "@/lib/device-storage";
import {
  msSinceRefresh,
  recordLastSpot,
  refreshAlerts,
  retryPending,
  syncPlaces,
  takePendingOpen,
  type TurnedOffReason,
} from "./client";
import { alertText, type AlertStringKey } from "./strings";

const HOUR_MS = 60 * 60 * 1000;
const FIX_WAIT_MS = 30 * 1000;

export type OpenRequest = { id: string; lat: number; lng: number };

const STOPPED: Record<Exclude<TurnedOffReason, null>, AlertStringKey> = {
  expired: "stoppedExpired",
  "no-places": "stoppedNoPlaces",
  blocked: "stoppedBlocked",
};

export function useAlertsUpkeep({
  enabled,
  on,
  lastLocation,
  turnedOffReason,
  position,
  places,
  customPlaces,
  onNotice,
  onOpen,
}: {
  // On / after consent only.
  enabled: boolean;
  on: boolean;
  lastLocation: boolean;
  turnedOffReason: TurnedOffReason;
  position: { lat: number; lng: number } | null;
  places: SavedPlaces;
  customPlaces: CustomPlace[];
  onNotice: (message: string) => void;
  onOpen: (request: OpenRequest) => void;
}) {
  const notice = useEffectEvent((message: string) => onNotice(message));
  const open = useEffectEvent((request: OpenRequest) => onOpen(request));

  // Each open, and on coming back after an hour or more.
  useEffect(() => {
    if (!enabled || !on) return;
    if (msSinceRefresh() >= HOUR_MS) void refreshAlerts();
    const onVisible = () => {
      if (document.visibilityState === "visible" && msSinceRefresh() >= HOUR_MS) void refreshAlerts();
    };
    const onOnline = () => void retryPending();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [enabled, on]);

  // Saved places changed (not on the first render: the refresh covers it).
  const signature = JSON.stringify([places, customPlaces]);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const previous = seen.current;
    seen.current = signature;
    if (previous !== null && previous !== signature && on) void syncPlaces();
  }, [enabled, on, signature]);

  // The last-opened spot: once per open (or per turning the option on).
  const fixDeadline = useRef(0);
  const stored = useRef(false);
  useEffect(() => {
    if (enabled && on && lastLocation) {
      fixDeadline.current = Date.now() + FIX_WAIT_MS;
      stored.current = false;
    }
  }, [enabled, on, lastLocation]);
  const lat = position?.lat;
  const lng = position?.lng;
  useEffect(() => {
    if (!enabled || !on || !lastLocation || lat === undefined || lng === undefined || stored.current) return;
    if (Date.now() > fixDeadline.current) return;
    stored.current = true;
    void recordLastSpot({ lat, lng });
  }, [enabled, on, lastLocation, lat, lng]);

  // Alerts that went off by themselves say why.
  const shownReason = useRef(turnedOffReason);
  useEffect(() => {
    if (turnedOffReason === shownReason.current) return;
    shownReason.current = turnedOffReason;
    if (enabled && turnedOffReason) notice(alertText(STOPPED[turnedOffReason]));
  }, [enabled, turnedOffReason]);

  // A tapped notification: on load, and when the worker says so.
  useEffect(() => {
    if (!enabled || !on || !("serviceWorker" in navigator)) return;
    // Read once and cleared, so it's handed on even if this effect was
    // cleaned up meanwhile (the map keeps the request in its state).
    const take = () =>
      void takePendingOpen().then((request) => {
        if (request) open(request);
      });
    const onMessage = (event: MessageEvent) => {
      if ((event.data as { type?: unknown } | null)?.type === "open-sighting") take();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    navigator.serviceWorker.startMessages();
    take();
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [enabled, on]);
}
