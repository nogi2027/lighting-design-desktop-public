export type ScriptReadingPreferences = { pages: boolean; font: "serif" | "sans" | "source"; size: number; leading: number; view: "formatted" | "pdf" };

function readingPreferences(value: string | null): ScriptReadingPreferences {
  let saved: Partial<ScriptReadingPreferences> = {};
  try { saved = JSON.parse(value || "{}") ?? {}; } catch { /* Use readable defaults. */ }
  return { pages: saved.pages === true, font: saved.font === "source" ? "source" : saved.font === "sans" ? "sans" : "serif", size: [16,18,20,22,24,26].includes(Number(saved.size)) ? Number(saved.size) : 16, leading: [1.4,1.5,1.65,1.9].includes(Number(saved.leading)) ? Number(saved.leading) : 1.5, view: "formatted" };
}

export function readPreference(key: string) {
  if (typeof window === "undefined") return { value: null, unavailable: false };
  try { return { value: window.localStorage.getItem(key), unavailable: false }; }
  catch { return { value: null, unavailable: true }; }
}

export function writePreference(key: string, value: string) {
  try { window.localStorage.setItem(key, value); return true; }
  catch { return false; }
}

export function initialPreferences() {
  const profile = readPreference("lt-active-profile");
  const theme = readPreference("lt-theme");
  const search = readPreference("lt-power-search");
  const reading = readPreference("lt-script-reading");
  const view = readPreference("lt-script-view");
  return {
    reading: readingPreferences(reading.value),
    profile: profile.value,
    theme: theme.value === "light" ? "light" as const : "dark" as const,
    powerSearch: search.value !== "off",
    unavailable: [profile, theme, search, reading, view].some((item) => item.unavailable),
  };
}
