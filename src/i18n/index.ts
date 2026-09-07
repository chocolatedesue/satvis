// The app's own strings, in the languages they are read in.
//
// Why a locale file at all, and why now: the orbit lab's notes are prose, and
// prose is the part of this UI that does not survive being hard-coded — a number
// can be read in any language, an explanation of what `Ω̇` does to a shell pair
// cannot. Every string a reader sees lives here; nothing in a component is
// literal text except numbers, units, orbit names and code identifiers.
//
// Two deliberate choices:
//
// - **The locale is per device, not per link.** Scene state travels in the url so
//   a link is a reproducible picture (`docs/adr/0001`); which language the reader
//   reads it in is not part of the picture, and putting it in the query string
//   would make every shared url carry a preference it has no business carrying.
//   So it is remembered in `localStorage` and nothing else.
// - **English is the fallback, and is the source of truth.** A key missing from
//   another locale falls back rather than rendering the key, so a translation can
//   lag a change without breaking the UI.

import { createI18n } from "vue-i18n";

import en from "./locales/en";
import zh from "./locales/zh";

export const SUPPORTED_LOCALES = ["en", "zh"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_LABEL: Record<SupportedLocale, string> = {
  // Named in their own languages, so a reader who cannot read the current one can
  // still find their way back — the one string that must never be translated.
  en: "English",
  zh: "中文",
};

const STORAGE_KEY = "satvis.locale";

function isSupported(value: unknown): value is SupportedLocale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Which language to open in.
 *
 * A remembered choice first, then the browser's, then English. `zh` matches on a
 * prefix rather than exactly, because what a browser reports is a tag
 * (`zh-CN`, `zh-TW`, `zh-Hans`) and not a language.
 */
function detectLocale(): SupportedLocale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isSupported(stored)) {
      return stored;
    }
  } catch {
    // Private browsing and blocked storage both throw here. A reader who cannot
    // have their choice remembered can still choose, per session.
  }
  const preferred = navigator.language?.toLowerCase() ?? "";
  if (preferred.startsWith("zh")) {
    return "zh";
  }
  return "en";
}

export const i18n = createI18n({
  legacy: false,
  // So a template can write `$t(...)` without every component importing
  // `useI18n` — the conversion is large enough without a per-file prelude.
  globalInjection: true,
  locale: detectLocale(),
  fallbackLocale: "en",
  messages: { en, zh },
});

/** Switch language, and remember it for next time. */
export function setLocale(locale: SupportedLocale): void {
  i18n.global.locale.value = locale;
  document.documentElement.lang = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // See detectLocale: a choice that cannot be remembered is still a choice.
  }
}

/** The locale currently in use. Reactive, so a control can bind to it. */
export function currentLocale(): SupportedLocale {
  const value = i18n.global.locale.value;
  return isSupported(value) ? value : "en";
}
