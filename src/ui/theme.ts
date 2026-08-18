import { loadSettings, saveSettings, type ThemePref } from '../storage/settings';

/**
 * Theme system: all colors are CSS custom properties on :root;
 * switching theme only swaps the token values via `data-theme` on <html>.
 * `system` follows prefers-color-scheme live via matchMedia.
 */

const media = window.matchMedia('(prefers-color-scheme: dark)');

function resolve(pref: ThemePref): 'light' | 'dark' {
  return pref === 'system' ? (media.matches ? 'dark' : 'light') : pref;
}

function apply(resolved: 'light' | 'dark'): void {
  document.documentElement.setAttribute('data-theme', resolved);
}

export function setThemePref(pref: ThemePref): void {
  saveSettings({ ...loadSettings(), theme: pref });
  apply(resolve(pref));
}

export function currentThemePref(): ThemePref {
  return loadSettings().theme;
}

/** Initialize the theme; returns a cleanup that stops following system changes. */
export function initTheme(): () => void {
  apply(resolve(currentThemePref()));

  const onChange = (): void => {
    if (currentThemePref() === 'system') apply(resolve('system'));
  };
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
