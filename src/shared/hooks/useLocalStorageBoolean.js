"use client";

import { useEffect, useState } from "react";

/**
 * Persist a boolean preference in localStorage.
 *
 * Wraps the read-on-mount + write-on-change pattern used by the quota page's
 * "auto-refresh" and "show depleted" toggles, so each new toggle doesn't
 * re-implement the same pair of effects.
 *
 * @param {string} key - localStorage key
 * @param {boolean} defaultValue - value used when the key is absent
 * @returns {[boolean, (v: boolean | ((prev: boolean) => boolean)) => void, boolean]}
 *   stateful value, a setter (boolean or updater fn, same shape as React's),
 *   and a `hydrated` flag that stays false until the initial localStorage read
 *   lands — so callers can gate side effects (e.g. an interval) that must not
 *   run off the default before the stored value is known.
 */
export function useLocalStorageBoolean(key, defaultValue = false) {
  const [hydrated, setHydrated] = useState(false);
  const [value, setValue] = useState(defaultValue);

  // Read once on mount (after hydration so SSR/CSR stay consistent).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(key);
    setValue(stored === null ? defaultValue : stored === "true");
    setHydrated(true);
    // defaultValue is captured at mount on purpose — changing it later has no
    // effect, matching how a one-time pref should behave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Persist on every change, but only after the initial hydration so we don't
  // overwrite a stored value with the default before reading it.
  useEffect(() => {
    if (typeof window === "undefined" || !hydrated) return;
    window.localStorage.setItem(key, String(value));
  }, [key, value, hydrated]);

  return [value, setValue, hydrated];
}
