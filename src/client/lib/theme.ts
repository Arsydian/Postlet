/**
 * @file src/client/lib/theme.ts
 * @description Color scheme state machine synchronized with `<meta name="color-scheme">` and CSS
 * `color-scheme` / `light-dark()` tokens, following modern-web-guidance `dark-mode-toggle` rules.
 */

import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "color-scheme";
const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

/**
 * Reads the persisted color-scheme override from `localStorage`, returning `"system"` when unset
 * or when storage access is blocked by browser privacy settings.
 */
export function readStoredPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark") {
      return raw;
    }
  } catch {
    // Ignore storage access errors in restricted browsing contexts.
  }
  return "system";
}

/**
 * Resolves the OS/browser's current `prefers-color-scheme` setting.
 */
export function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia(DARK_MEDIA_QUERY).matches ? "dark" : "light";
}

/**
 * Mirrors the active preference into `<meta name="color-scheme">` (`light`, `dark`, or
 * `light dark`) so CSS `:root:has(...)`, `light-dark()`, scrollbars, and form controls update
 * immediately without relying on a JS-only class.
 */
export function applyMetaColorScheme(preference: ThemePreference): void {
  if (typeof document === "undefined") return;
  const contentValue = preference === "system" ? "light dark" : preference;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "color-scheme";
    document.head.appendChild(meta);
  }
  if (meta.content !== contentValue) {
    meta.content = contentValue;
  }
}

export interface UseThemeResult {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  systemTheme: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
  toggleTheme: () => void;
}

/**
 * Manages the user's color scheme preference (`system` | `light` | `dark`), reactive OS media
 * query changes, and cross-tab `storage` synchronization.
 */
export function useTheme(): UseThemeResult {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredPreference());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => getSystemTheme());

  const resolvedTheme: ResolvedTheme = preference === "system" ? systemTheme : preference;

  useEffect(() => {
    applyMetaColorScheme(preference);
  }, [preference]);

  // Listen to OS/browser scheme changes without clearing an explicitly pinned override.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(DARK_MEDIA_QUERY);
    const onMediaChange = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? "dark" : "light");
    };
    mql.addEventListener("change", onMediaChange);
    return () => mql.removeEventListener("change", onMediaChange);
  }, []);

  // Synchronize color scheme overrides modified in another browser tab.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      const next = readStoredPreference();
      setPreferenceState(next);
      applyMetaColorScheme(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      if (next === "system") {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      // Still apply theme for the active session even if persistence fails.
    }
    applyMetaColorScheme(next);
    setPreferenceState(next);
  }, []);

  /**
   * Smart two-state toggle for compact chrome controls: flips the currently rendered scheme, and
   * removes the override (returning to system default) when the target matches the current OS mode.
   */
  const toggleTheme = useCallback(() => {
    const currentSystem = getSystemTheme();
    const target: ResolvedTheme = resolvedTheme === "dark" ? "light" : "dark";
    if (target === currentSystem) {
      setPreference("system");
    } else {
      setPreference(target);
    }
  }, [resolvedTheme, setPreference]);

  return {
    preference,
    resolvedTheme,
    systemTheme,
    setPreference,
    toggleTheme,
  };
}
