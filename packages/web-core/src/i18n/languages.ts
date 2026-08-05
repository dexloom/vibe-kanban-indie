/**
 * Centralized language configuration for the i18n system.
 */

export const UI_TO_I18N = {
  EN: 'en',
} as const;

const SUPPORTED_UI_LANGUAGES = ['BROWSER', 'EN'] as const;
export const SUPPORTED_I18N_CODES = Object.values(UI_TO_I18N);

const FALLBACK_ENDONYMS = {
  en: 'English',
} as const;

/**
 * Convert UiLanguage enum value to i18next language code
 */
export function uiLanguageToI18nCode(uiLang: string): string | undefined {
  return uiLang === 'BROWSER'
    ? undefined
    : UI_TO_I18N[uiLang as keyof typeof UI_TO_I18N];
}

/**
 * Get the native name (endonym) of a language using Intl.DisplayNames
 */
function getEndonym(langCode: string): string {
  try {
    return (
      new Intl.DisplayNames([langCode], { type: 'language' }).of(langCode) ||
      FALLBACK_ENDONYMS[langCode as keyof typeof FALLBACK_ENDONYMS] ||
      langCode
    );
  } catch {
    return (
      FALLBACK_ENDONYMS[langCode as keyof typeof FALLBACK_ENDONYMS] || langCode
    );
  }
}

/**
 * Get language options for dropdown with proper display names
 */
export function getLanguageOptions(browserDefaultLabel: string) {
  return SUPPORTED_UI_LANGUAGES.map((ui) => ({
    value: ui,
    label:
      ui === 'BROWSER'
        ? browserDefaultLabel
        : getEndonym(UI_TO_I18N[ui as keyof typeof UI_TO_I18N]),
  }));
}
