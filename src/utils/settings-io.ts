import { Vault } from 'obsidian';
import { PluginSettings } from '../settings';

const SETTINGS_EXPORT_FILE = '.obsidian/plugins/hybrid-git-sync/settings-export.json';

/**
 * Settings import/export utility
 */
export class SettingsIO {
  private vault: Vault;

  constructor(vault: Vault) {
    this.vault = vault;
  }

  /**
   * Export settings to file
   */
  async exportSettings(settings: PluginSettings): Promise<void> {
    const exportData = {
      version: '1.0',
      exportDate: new Date().toISOString(),
      settings: {
        ...settings,
        // Exclude sensitive data
        apiToken: settings.apiToken ? '***REDACTED***' : '',
      },
    };

    const content = JSON.stringify(exportData, null, 2);
    await this.vault.adapter.write(SETTINGS_EXPORT_FILE, content);
  }

  /**
   * Import settings from file
   */
  async importSettings(): Promise<PluginSettings | null> {
    try {
      const content = await this.vault.adapter.read(SETTINGS_EXPORT_FILE);
      const data = JSON.parse(content);

      if (!data.version || !data.settings) {
        throw new Error('Invalid settings file format');
      }

      // Don't import token for security
      const settings = data.settings;
      settings.apiToken = '';

      return settings;
    } catch (error) {
      console.error('[SettingsIO] Failed to import settings:', error);
      return null;
    }
  }

  /**
   * Export settings as JSON string (for clipboard)
   */
  exportAsString(settings: PluginSettings): string {
    const exportData = {
      version: '1.0',
      exportDate: new Date().toISOString(),
      settings: {
        ...settings,
        apiToken: settings.apiToken ? '***REDACTED***' : '',
      },
    };

    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Import settings from JSON string
   */
  importFromString(jsonString: string): PluginSettings | null {
    try {
      const data = JSON.parse(jsonString);

      if (!data.version || !data.settings) {
        throw new Error('Invalid settings format');
      }

      const settings = data.settings;
      settings.apiToken = '';

      return settings;
    } catch (error) {
      console.error('[SettingsIO] Failed to parse settings:', error);
      return null;
    }
  }
}
