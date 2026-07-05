import en from './locales/en';
import zh from './locales/zh';
import { App, getLanguage } from 'obsidian';

export type Locale = 'en' | 'zh';

const locales: Record<Locale, Record<string, string>> = {
  en,
  zh,
};

/**
 * Simple i18n system for the plugin
 */
export class I18n {
  private locale: Locale;
  private translations: Record<string, string>;

  constructor() {
    this.locale = this.detectLocale();
    this.translations = locales[this.locale] || locales.en;
  }

  /**
   * Detect locale from Obsidian or system
   */
  private detectLocale(): Locale {
    // Use Obsidian's getLanguage() API
    const obsidianLang = getLanguage();
    console.log('[HybridGitSync] Obsidian language:', obsidianLang);

    if (obsidianLang) {
      if (obsidianLang.startsWith('zh')) return 'zh';
      if (obsidianLang.startsWith('en')) return 'en';
    }

    // Fallback to system locale
    const systemLocale = navigator.language;
    console.log('[HybridGitSync] System locale (fallback):', systemLocale);
    if (systemLocale.startsWith('zh')) return 'zh';

    return 'en';
  }

  /**
   * Get translated string
   * @param key Translation key
   * @param params Optional parameters for interpolation
   */
  t(key: string, params?: Record<string, string | number>): string {
    let text = this.translations[key] || key;

    if (params) {
      Object.entries(params).forEach(([paramKey, value]) => {
        text = text.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(value));
      });
    }

    return text;
  }

  /**
   * Get current locale
   */
  getLocale(): Locale {
    return this.locale;
  }

  /**
   * Set locale
   */
  setLocale(locale: Locale): void {
    this.locale = locale;
    this.translations = locales[locale] || locales.en;
  }
}

// Singleton instance
let i18nInstance: I18n | null = null;

/**
 * Initialize i18n (call once in plugin onload)
 */
export function initI18n(): I18n {
  i18nInstance = new I18n();
  return i18nInstance;
}

/**
 * Get i18n instance (must call initI18n first)
 */
export function getI18n(): I18n {
  if (!i18nInstance) {
    // Fallback: create without app (for non-plugin contexts)
    i18nInstance = new I18n();
  }
  return i18nInstance;
}

/**
 * Shorthand for translation
 */
export function t(key: string, params?: Record<string, string | number>): string {
  return getI18n().t(key, params);
}
