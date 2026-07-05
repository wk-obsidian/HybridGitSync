import { Vault } from 'obsidian';
import { PluginSettings } from '../settings';

const SETTINGS_EXPORT_FILE_NAME = 'plugins/hybrid-git-sync/settings-export.json';

/**
 * Settings import/export utility
 */
export class SettingsIO {
  private vault: Vault;
  private exportFile: string;

  constructor(vault: Vault) {
    this.vault = vault;
    this.exportFile = `${vault.configDir}/${SETTINGS_EXPORT_FILE_NAME}`;
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
        apiToken: settings.apiToken ? '***REDACTED***' : '',
      },
    };

    const content = JSON.stringify(exportData, null, 2);
    await this.vault.adapter.write(this.exportFile, content);
  }

  /**
   * Import settings from file
   */
  async importSettings(): Promise<PluginSettings | null> {
    try {
      const content = await this.vault.adapter.read(this.exportFile);
      const data = JSON.parse(content) as { version: string; settings: PluginSettings };

      if (!data.version || !data.settings) {
        throw new Error('Invalid settings file format');
      }

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
