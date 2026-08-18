/**
 * Persisted user settings (localStorage). Settings are the only
 * localStorage consumers besides i18n's language choice.
 */
export type ThemePref = 'light' | 'dark' | 'system';

export interface AppSettings {
  theme: ThemePref;
}

const KEY = 'inpaint.settings';

const DEFAULTS: AppSettings = { theme: 'system' };

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      theme: parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'system' ? parsed.theme : DEFAULTS.theme,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* ignore quota / private mode */
  }
}
