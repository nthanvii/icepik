"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  alertSupport,
  disableAlerts,
  enableAlerts,
  prepareAlerts,
  releaseAlerts,
  updateAlertSettings,
  useAlertSettings,
  type AlertResult,
} from "@/lib/alerts/client";
import { alertText } from "@/lib/alerts/strings";
import { ALERT_DISTANCES_MI } from "@/lib/push-cells";
import {
  useLocationAnswer,
  type CustomPlace,
  type SavedPlaces,
} from "@/lib/device-storage";
import { Captcha, captchaEnabled } from "./captcha";

// How many places can be switched on at once (the server's limit).
const MAX_PLACES = 5;

// The release of the worker waits one tick, so React's double mount in
// development (mount, unmount, mount) doesn't unregister a worker that the
// second mount just registered.
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

type Row = { id: string; label: string; set: boolean };

// The Alerts screen, a sub-view of Settings on / only. Every text is in
// lib/alerts/strings.ts. Opening it registers the service worker (so the
// tap that turns alerts on can subscribe at once); leaving it with alerts
// off removes the worker again.
export function AlertsSettings({
  places,
  customPlaces,
  onBack,
}: {
  places: SavedPlaces;
  customPlaces: CustomPlace[];
  onBack: () => void;
}) {
  const settings = useAlertSettings();
  const location = useLocationAnswer();
  const [support, setSupport] = useState(alertSupport);
  const [ready, setReady] = useState(false);
  // The warning's box: unticked each time the screen opens.
  const [understood, setUnderstood] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [captchaBroken, setCaptchaBroken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmLast, setConfirmLast] = useState(false);
  // What the last action did, read from a polite live region.
  const [status, setStatus] = useState("");
  const statusId = useId();
  const needsId = useId();
  const stateHeading = useRef<HTMLHeadingElement>(null);
  const lastHeading = useRef<HTMLHeadingElement>(null);
  const lastSwitch = useRef<HTMLInputElement>(null);

  useEffect(() => {
    clearTimeout(releaseTimer);
    let cancelled = false;
    if (alertSupport() === "ok") {
      void prepareAlerts().then((ok) => {
        if (!cancelled) setReady(ok);
      });
    }
    return () => {
      cancelled = true;
      releaseTimer = setTimeout(() => void releaseAlerts(), 0);
    };
  }, []);

  // After alerts turn on or off, the button that was used is gone: focus
  // moves to the heading of the new state, once it has rendered.
  const focusState = () =>
    setTimeout(() => stateHeading.current?.focus({ preventScroll: true }), 50);

  useEffect(() => {
    if (confirmLast) lastHeading.current?.focus({ preventScroll: true });
  }, [confirmLast]);

  const rows: Row[] = [
    { id: "home", label: "Home", set: Boolean(places.home) },
    { id: "work", label: "Work", set: Boolean(places.work) },
    ...customPlaces.map((place) => ({ id: place.id, label: place.name, set: true })),
  ];
  const existing = new Set(rows.filter((row) => row.set).map((row) => row.id));
  const watched = settings.placeIds.filter((id) => existing.has(id));
  const full = watched.length >= MAX_PLACES;
  const anySaved = rows.some((row) => row.set);

  async function change(patch: Parameters<typeof updateAlertSettings>[0]) {
    const result = await updateAlertSettings(patch);
    setStatus(result.message);
    return result;
  }

  function togglePlace(id: string, on: boolean) {
    void change({ placeIds: on ? [...watched, id] : watched.filter((other) => other !== id) });
  }

  // Called straight from the click: on iPhones enableAlerts() has to run
  // before anything that waits, so nothing here awaits first.
  function turnOn() {
    if (busy) return;
    setStatus("");
    const refusedFirst = !understood || watched.length === 0;
    if (!refusedFirst && captchaEnabled && !token) return setStatus(alertText("captchaWait"));
    setBusy(true);
    let pending: Promise<AlertResult>;
    try {
      pending = enableAlerts(captchaEnabled ? token : "", understood);
    } catch {
      setBusy(false);
      return;
    }
    void pending.then((result) => {
      setBusy(false);
      setStatus(result.message);
      setSupport(alertSupport());
      if (result.ok) focusState();
      else if (captchaEnabled) {
        // A token works once.
        setToken(null);
        setCaptchaReset((count) => count + 1);
      }
    });
  }

  function turnOff() {
    if (busy) return;
    setBusy(true);
    void disableAlerts().then(() => {
      setBusy(false);
      focusState();
      setUnderstood(false);
      setStatus(alertText("turnedOff"));
    });
  }

  const needs = [
    watched.length === 0 ? alertText("needPlaceItem") : null,
    !understood ? alertText("needBoxItem") : null,
    captchaEnabled && !token ? alertText("needCheckItem") : null,
    !ready ? alertText("needReadyItem") : null,
  ].filter((item): item is string => item !== null);
  // Not `disabled`: a tap with something missing says what, in the live region.
  const blocked = needs.length > 0 || busy;

  return (
    <>
      <section className="settings-section" aria-labelledby="alerts-view-title">
        <h3 id="alerts-view-title">{alertText("screenTitle")}</h3>
        {support === "ok" && !settings.on && settings.turnedOffReason ? (
          <p className="detail-hint">
            {alertText(
              settings.turnedOffReason === "blocked"
                ? "reasonBlocked"
                : settings.turnedOffReason === "expired"
                  ? "reasonExpired"
                  : "reasonNoPlaces",
            )}
          </p>
        ) : null}
        <fieldset className="choice-group">
          <legend>{alertText("distanceLegend")}</legend>
          <div className="choices">
            {ALERT_DISTANCES_MI.map((miles) => (
              <label key={miles} className="choice">
                <input
                  type="radio"
                  name="alert-distance"
                  value={miles}
                  checked={settings.distanceMiles === miles}
                  onChange={() => void change({ distanceMiles: miles })}
                />
                <span className="choice-label">{alertText("distanceOption", { n: miles })}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="detail-hint">{alertText("distanceNote")}</p>

        <label className="switch-row">
          <span className="switch-text">
            <span id="near-me-label" className="switch-label">
              {alertText("nearMeLabel")}
            </span>
            <span id="near-me-hint" className="detail-hint">
              {alertText("nearMeHint")}
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={settings.nearMeInApp}
              onChange={(event) => void change({ nearMeInApp: event.target.checked })}
              aria-labelledby="near-me-label"
              aria-describedby="near-me-hint"
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
      </section>

      {support === "not-configured" ? (
        <section className="settings-section">
          <p>{alertText("notConfigured")}</p>
        </section>
      ) : null}
      {support === "install-ios" ? (
        <section className="settings-section">
          <p>{alertText("installIntro")}</p>
          <ol>
            <li>{alertText("installStep1")}</li>
            <li>{alertText("installStep2")}</li>
            <li>{alertText("installStep3")}</li>
          </ol>
        </section>
      ) : null}
      {support === "ios-too-old" ? (
        <section className="settings-section">
          <p>{alertText("iosTooOld")}</p>
        </section>
      ) : null}
      {support === "unsupported" ? (
        <section className="settings-section">
          <p>{alertText("unsupported")}</p>
        </section>
      ) : null}
      {support === "blocked" ? (
        <section className="settings-section">
          <p>{alertText("blockedHelp")}</p>
        </section>
      ) : null}

      {support === "ok" ? (
        <section className="settings-section" aria-labelledby="alerts-places-title">
          <h3 id="alerts-places-title">{alertText("placesHeading")}</h3>
          <p className="detail-hint">{alertText("placesHint")}</p>
          {rows.map((row) => {
            const on = watched.includes(row.id);
            const labelId = `alert-place-${row.id}`;
            const hintId = `${labelId}-hint`;
            const tooMany = !on && full && row.set;
            const reason = !row.set ? alertText("placeNotSet") : tooMany ? alertText("tooManyPlaces") : null;
            return (
              <label key={row.id} className="switch-row">
                <span className="switch-text">
                  <span id={labelId} className="switch-label">
                    {row.label}
                  </span>
                  {reason ? (
                    <span id={hintId} className="detail-hint">
                      {reason}
                    </span>
                  ) : null}
                </span>
                <span className="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={on}
                    disabled={!row.set || tooMany}
                    onChange={(event) => togglePlace(row.id, event.target.checked)}
                    aria-labelledby={labelId}
                    aria-describedby={reason ? hintId : undefined}
                  />
                  <span className="switch-track" aria-hidden="true" />
                </span>
              </label>
            );
          })}
          {!anySaved ? <p className="detail-hint">{alertText("noSavedPlaces")}</p> : null}
        </section>
      ) : null}

      {support === "ok" && !settings.on ? (
        <>
          <section className="settings-section">
            <p>{alertText("whatAlertsDo")}</p>
          </section>
          <section className="settings-section" aria-labelledby="alerts-warning-title">
            <h3 id="alerts-warning-title" ref={stateHeading} tabIndex={-1}>{alertText("warningHeading")}</h3>
            <p>{alertText("warning1")}</p>
            <p>{alertText("warning2")}</p>
            <p>{alertText("warning3")}</p>
            <p>{alertText("warning4")}</p>
            <p>{alertText("warning5")}</p>
            <p>{alertText("warning6")}</p>
            <label className="switch-row">
              <span className="switch-label">{alertText("understoodLabel")}</span>
              <input
                type="checkbox"
                checked={understood}
                onChange={(event) => setUnderstood(event.target.checked)}
              />
            </label>
            {captchaEnabled ? (
              <Captcha
                action="alerts"
                onToken={(next) => {
                  setToken(next);
                  if (next) setCaptchaBroken(false);
                }}
                onError={() => setCaptchaBroken(true)}
                resetKey={captchaReset}
              />
            ) : null}
            {captchaBroken ? <p className="form-error">{alertText("captchaFailed")}</p> : null}
            <div className="button-row">
              <button
                type="button"
                className="primary-button"
                aria-disabled={blocked || undefined}
                aria-describedby={needsId}
                onClick={turnOn}
              >
                {busy ? alertText("turningOn") : alertText("turnOn")}
              </button>
            </div>
            <p id={needsId} className="detail-hint">
              {needs.length
                ? `${alertText("needsLead")} ${needs.join(", ")}.`
                : alertText("readyToTurnOn")}
            </p>
          </section>
        </>
      ) : null}

      {support === "ok" && settings.on ? (
        <section className="settings-section" aria-labelledby="alerts-on-title">
          <h3 id="alerts-on-title" ref={stateHeading} tabIndex={-1}>
            {alertText("alertsAreOn")}
          </h3>
          <p>{alertText("thirtyDays")}</p>
          <div className="button-row">
            <button type="button" className="secondary-button" onClick={turnOff} disabled={busy}>
              {busy ? alertText("turningOff") : alertText("turnOff")}
            </button>
          </div>
          <label className="switch-row">
            <span className="switch-text">
              <span id="details-label" className="switch-label">
                {alertText("detailsLabel")}
              </span>
              <span id="details-hint" className="detail-hint">
                {alertText("detailsHint")}
              </span>
            </span>
            <span className="switch">
              <input
                type="checkbox"
                role="switch"
                checked={settings.showDetails}
                onChange={(event) => void change({ showDetails: event.target.checked })}
                aria-labelledby="details-label"
                aria-describedby="details-hint"
              />
              <span className="switch-track" aria-hidden="true" />
            </span>
          </label>
          {confirmLast ? (
            <div role="group" aria-labelledby="last-title">
              <h3 id="last-title" ref={lastHeading} tabIndex={-1}>
                {alertText("lastHeading")}
              </h3>
              <p>{alertText("lastWarning")}</p>
              <div className="button-row">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    setConfirmLast(false);
                    void change({ lastLocation: true });
                  }}
                >
                  {alertText("lastConfirm")}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setConfirmLast(false);
                    requestAnimationFrame(() => lastSwitch.current?.focus());
                  }}
                >
                  {alertText("lastCancel")}
                </button>
              </div>
            </div>
          ) : (
            <label className="switch-row">
              <span className="switch-text">
                <span id="last-label" className="switch-label">
                  {alertText("lastLabel")}
                </span>
                <span id="last-hint" className="detail-hint">
                  {alertText("lastHint")}
                  {location !== "granted" ? ` ${alertText("lastNoLocation")}` : ""}
                </span>
              </span>
              <span className="switch">
                <input
                  ref={lastSwitch}
                  type="checkbox"
                  role="switch"
                  checked={settings.lastLocation}
                  onChange={(event) => {
                    if (event.target.checked) setConfirmLast(true);
                    else void change({ lastLocation: false });
                  }}
                  aria-labelledby="last-label"
                  aria-describedby="last-hint"
                />
                <span className="switch-track" aria-hidden="true" />
              </span>
            </label>
          )}
        </section>
      ) : null}

      {/* What the last action did, also for screen readers. */}
      <p id={statusId} className="detail-hint" role="status" aria-live="polite">
        {status}
      </p>
      <div className="form-actions sticky-actions">
        <button type="button" className="secondary-button" onClick={onBack}>
          {alertText("back")}
        </button>
      </div>
    </>
  );
}
