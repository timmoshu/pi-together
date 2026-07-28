// client/src/theme.ts — light / dark / system theme, persisted. The stylesheet already defines
// :root[data-theme="light"|"dark"] overrides plus a prefers-color-scheme default, so switching is
// just a matter of setting (or clearing) data-theme on the document root.
export type Theme = "system" | "light" | "dark";
const KEY = "pi-together:theme";

export function getTheme(): Theme {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
  return v === "light" || v === "dark" ? v : "system";
}

export function applyTheme(t: Theme): void {
  const el = document.documentElement;
  if (t === "system") delete el.dataset.theme;
  else el.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode / storage disabled */
  }
}

export const THEME_CYCLE: Theme[] = ["system", "light", "dark"];
export const nextTheme = (t: Theme): Theme => THEME_CYCLE[(THEME_CYCLE.indexOf(t) + 1) % THEME_CYCLE.length]!;
