import en from './locales/en';
import zh from './locales/zh';

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

  constructor(locale?: Locale) {
    this.locale = locale || this.detectLocale();
    this.translations = locales[this.locale] || locales.en;
  }

  /**
   * Detect locale from Obsidian or system
   */
  private detectLocale(): Locale {
    // Try to get locale from Obsidian
    const obsidianLocale = (window as any).app?.locale;
    if (obsidianLocale) {
      if (obsidianLocale.startsWith('zh')) return 'zh';
    }

    // Try to get locale from system
    const systemLocale = navigator.language;
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

export function getI18n(): I18n {
  if (!i18nInstance) {
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
