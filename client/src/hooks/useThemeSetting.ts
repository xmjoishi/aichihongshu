import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "aichihongshu.appearance.v1";

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch {
    // Storage can be unavailable in a restricted preview; system remains safe.
  }
  return "system";
}

function resolveTheme(preference: ThemePreference): "light" | "dark" {
  if (preference !== "system") return preference;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(preference: ThemePreference) {
  const root = document.documentElement;
  root.setAttribute("data-theme-preference", preference);
  root.setAttribute("data-theme", resolveTheme(preference));
  root.style.colorScheme = resolveTheme(preference);
}

export function initializeTheme() {
  applyTheme(readPreference());
}

export function useThemeSetting() {
  const [preference, setPreference] = useState<ThemePreference>(() => readPreference());

  useEffect(() => {
    applyTheme(preference);
    if (preference !== "system" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => applyTheme("system");
    media.addEventListener?.("change", handleChange);
    return () => media.removeEventListener?.("change", handleChange);
  }, [preference]);

  const update = useCallback((next: ThemePreference) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Keep the current session usable even when persistence is unavailable.
    }
    setPreference(next);
    applyTheme(next);
  }, []);

  return { preference, setPreference: update };
}
