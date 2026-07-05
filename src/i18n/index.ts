import en from './locales/en';
import zh from './locales/zh';
import { App } from 'obsidian';

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

  constructor(app?: App) {
    this.locale = this.detectLocale(app);
    this.translations = locales[this.locale] || locales.en;
  }

  /**
   * Detect locale from Obsidian or system
   */
  private detectLocale(app?: App): Locale {
    if (app) {
      // Try different ways to get Obsidian language
      const appAny = app as Record<string, unknown>;

      // Check for language property
      const lang = appAny.language || appAny.locale;
      console.log('[HybridGitSync] Detected language property:', lang);

      if (lang && typeof lang === 'string') {
        if (lang.startsWith('zh')) return 'zh';
        if (lang.startsWith('en')) return 'en';
      }

      // Try to get from vault config
      try {
        const vault = appAny.vault as Record<string, unknown> | undefined;
        const config = vault?.config as Record<string, unknown> | undefined;
        if (config?.locale) {
          console.log('[HybridGitSync] Vault config locale:', config.locale);
          if (typeof config.locale === 'string' && config.locale.startsWith('zh')) return 'zh';
        }
      } catch {
        // ignore
      }
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
 * Initialize i18n with app instance (call once in plugin onload)
 */
export function initI18n(app: App): I18n {
  i18nInstance = new I18n(app);
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
