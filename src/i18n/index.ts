import { en, type Messages } from './locales/en';
import { zhCN } from './locales/zh-CN';

export type Lang = keyof typeof REGISTRY;

/** Locale registry. Adding a language = add one locale file and register it here. */
export const REGISTRY = {
  en,
  'zh-CN': zhCN,
} as const satisfies Record<string, Messages>;

const STORAGE_KEY = 'inpaint.lang';
export const LANGS: Lang[] = Object.keys(REGISTRY) as Lang[];

let current: Lang = detectLang();

type Listener = () => void;
const listeners = new Set<Listener>();

/** Exact match → parent-family fallback (zh-TW → zh-CN) → English. */
function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as Lang | null;
    if (saved && saved in REGISTRY) return saved;
  } catch {
    /* localStorage unavailable */
  }
  const nav = navigator.language ?? 'en';
  if (nav in REGISTRY) return nav as Lang;
  const family = nav.split('-')[0] ?? '';
  if (family === 'zh') return 'zh-CN'; // family default pack
  return 'en';
}

/** Interpolate {var} placeholders in a message. */
export function t(key: keyof Messages, vars: Record<string, string | number> = {}): string {
  let msg: string = REGISTRY[current][key];
  for (const [k, v] of Object.entries(vars)) {
    msg = msg.replaceAll(`{${k}}`, String(v));
  }
  return msg;
}

export function setLang(lang: Lang): void {
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore */
  }
  applyI18n();
  for (const l of listeners) l();
}

export function getLang(): Lang {
  return current;
}

export function onLangChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Apply current language to <html lang> and all data-i18n nodes. */
export function applyI18n(root: ParentNode = document): void {
  document.documentElement.lang = current;
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n as keyof Messages);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle as keyof Messages);
  });
}
