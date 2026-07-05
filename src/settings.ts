import { App, PluginSettingTab, Setting } from 'obsidian';
import type HybridGitSyncPlugin from './main';
import { t } from './i18n';

export interface PluginSettings {
  // General
  language: 'auto' | 'en' | 'zh';  // UI language

  // Backend
  backend: 'auto' | 'git' | 'api';

  // Remote
  remoteUrl: string;           // git remote URL (desktop) or "owner/repo" (mobile)
  branch: string;              // branch to sync

  // API (mobile)
  apiProvider: 'github' | 'gitlab' | 'gitea';
  apiToken: string;            // Personal Access Token
  apiBaseUrl: string;          // custom API endpoint (for self-hosted)

  // Git (desktop)
  gitPath: string;             // path to git binary

  // Auto sync
  autoSync: boolean;
  autoSyncInterval: number;    // in minutes
  syncOnStartup: boolean;
  syncOnFileChange: boolean;
  fileChangeDebounce: number;  // in seconds

  // Behavior
  commitMessage: string;       // commit message template
  pullStrategy: 'merge' | 'rebase';
  showNotice: boolean;         // show notification on sync

  // Advanced
  debug: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  language: 'auto',
  backend: 'auto',
  remoteUrl: '',
  branch: 'main',
  apiProvider: 'github',
  apiToken: '',
  apiBaseUrl: '',
  gitPath: '/usr/local/bin/git',
  autoSync: true,
  autoSyncInterval: 10,
  syncOnStartup: true,
  syncOnFileChange: true,
  fileChangeDebounce: 30,
  commitMessage: 'vault backup: {{date}}',
  pullStrategy: 'rebase',
  showNotice: true,
  debug: false,
};

export class SettingsTab extends PluginSettingTab {
  plugin: HybridGitSyncPlugin;

  constructor(app: App, plugin: HybridGitSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: t('settings.title') });

    // Platform info
    const infoEl = containerEl.createDiv('setting-item-info');
    infoEl.createEl('span', {
      text: t('settings.platformInfo', {
        platform: this.plugin.getPlatformName(),
        backend: this.plugin.getActiveBackendName()
      })
    });
    containerEl.createEl('hr');

    this.renderGeneralSettings(containerEl);
    this.renderBackendSettings(containerEl);
    this.renderRemoteSettings(containerEl);
    this.renderAutoSyncSettings(containerEl);
    this.renderBehaviorSettings(containerEl);
    this.renderAdvancedSettings(containerEl);
  }

  private renderGeneralSettings(el: HTMLElement): void {
    new Setting(el).setName(t('settings.general')).setHeading();

    new Setting(el)
      .setName(t('settings.language'))
      .setDesc(t('settings.languageDesc'))
      .addDropdown(cb => cb
        .addOption('auto', t('settings.languageAuto'))
        .addOption('en', t('settings.languageEn'))
        .addOption('zh', t('settings.languageZh'))
        .setValue(this.plugin.settings.language)
        .onChange(async (value) => {
          this.plugin.settings.language = value as PluginSettings['language'];
          await this.plugin.saveSettings();
        }));
  }

  private renderBackendSettings(el: HTMLElement): void {
    new Setting(el).setName(t('settings.backend')).setHeading();

    new Setting(el)
      .setName(t('settings.backendMode'))
      .setDesc(t('settings.backendModeDesc'))
      .addDropdown(cb => cb
        .addOption('auto', t('settings.backendAuto'))
        .addOption('git', t('settings.backendGit'))
        .addOption('api', t('settings.backendApi'))
        .setValue(this.plugin.settings.backend)
        .onChange(async (value) => {
          this.plugin.settings.backend = value as PluginSettings['backend'];
          await this.plugin.saveSettings();
        }));
  }

  private renderRemoteSettings(el: HTMLElement): void {
    new Setting(el).setName(t('settings.remote')).setHeading();

    new Setting(el)
      .setName(t('settings.remoteUrl'))
      .setDesc(t('settings.remoteUrlDesc'))
      .addText(cb => cb
        .setPlaceholder('owner/repo')
        .setValue(this.plugin.settings.remoteUrl)
        .onChange(async (value) => {
          this.plugin.settings.remoteUrl = value;
          await this.plugin.saveSettings();
        }));

    new Setting(el)
      .setName(t('settings.branch'))
      .setDesc(t('settings.branchDesc'))
      .addText(cb => cb
        .setPlaceholder('main')
        .setValue(this.plugin.settings.branch)
        .onChange(async (value) => {
          this.plugin.settings.branch = value;
          await this.plugin.saveSettings();
        }));

    // API settings
    new Setting(el)
      .setName(t('settings.apiProvider'))
      .setDesc(t('settings.apiProviderDesc'))
      .addDropdown(cb => cb
        .addOption('github', 'GitHub')
        .addOption('gitlab', 'GitLab')
        .addOption('gitea', 'Gitea')
        .setValue(this.plugin.settings.apiProvider)
        .onChange(async (value) => {
          this.plugin.settings.apiProvider = value as PluginSettings['apiProvider'];
          await this.plugin.saveSettings();
        }));

    new Setting(el)
      .setName(t('settings.apiToken'))
      .setDesc(t('settings.apiTokenDesc'))
      .addText(cb => {
        cb.inputEl.type = 'password';
        cb.inputEl.style.width = '100%';
        cb
          .setPlaceholder('ghp_xxxx...')
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            this.plugin.settings.apiToken = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(el)
      .setName(t('settings.customApiUrl'))
      .setDesc(t('settings.customApiUrlDesc'))
      .addText(cb => cb
        .setPlaceholder('https://your-gitea.com/api/v1')
        .setValue(this.plugin.settings.apiBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.apiBaseUrl = value;
          await this.plugin.saveSettings();
        }));

    // Git settings (desktop)
    new Setting(el)
      .setName(t('settings.gitPath'))
      .setDesc(t('settings.gitPathDesc'))
      .addText(cb => cb
        .setPlaceholder('git')
        .setValue(this.plugin.settings.gitPath)
        .onChange(async (value) => {
          this.plugin.settings.gitPath = value;
          await this.plugin.saveSettings();
        }));
  }

  private renderAutoSyncSettings(el: HTMLElement): void {
    new Setting(el).setName(t('settings.autoSync')).setHeading();

    new Setting(el)
      .setName(t('settings.enableAutoSync'))
      .setDesc(t('settings.enableAutoSyncDesc'))
      .addToggle(cb => cb
        .setValue(this.plugin.settings.autoSync)
        .onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        }));

    new Setting(el)
      .setName(t('settings.syncInterval'))
      .setDesc(t('settings.syncIntervalDesc'))
      .addText(cb => cb
        .setPlaceholder('10')
        .setValue(String(this.plugin.settings.autoSyncInterval))
        .onChange(async (value) => {
          this.plugin.settings.autoSyncInterval = parseInt(value) || 10;
          await this.plugin.saveSettings();
        }));

    new Setting(el)
      .setName(t('settings.syncOnStartup'))
      .setDesc(t('settings.syncOnStartupDesc'))
      .addToggle(cb => cb
        .setValue(this.plugin.settings.syncOnStartup)
        .onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        }));

    new Setting(el)
      .setName(t('settings.syncOnFileChange'))
      .setDesc(t('settings.syncOnFileChangeDesc'))
      .addToggle(cb => cb
        .setValue(this.plugin.settings.syncOnFileChange)
        .onChange(async (value) => {
          this.plugin.settings.syncOnFileChange = value;
          await this.plugin.saveSettings();
        }));

    new Setting(el)
      .setName(t('settings.fileChangeDebounce'))
      .setDesc(t('settings.fileChangeDebounceDesc'))
      .addText(cb => cb
        .setPlaceholder('30')
        .setValue(String(this.plugin.settings.fileChangeDebounce))
        .onChange(async (value) => {
          this.plugin.settings.fileChangeDebounce = parseInt(value) || 30;
          await this.plugin.saveSettings();
        }));
  }

  private renderBehaviorSettings(el: HTMLElement): void {
    new Setting(el).setName(t('settings.behavior')).setHeading();

    new Setting(el)
      .setName(t('settings.commitMessage'))
      .setDesc(t('settings.commitMessageDesc'))
      .addText(cb => cb
        .setPlaceholder('vault backup: {{date}}')
        .setValue(this.plugin.settings.commitMessage)
        .onChange(async (value) => {
          this.plugin.settings.commitMessage = value;
          await this.plugin.saveSettings();
        }));

    new Setting(el)
      .setName(t('settings.pullStrategy'))
      .setDesc(t('settings.pullStrategyDesc'))
      .addDropdown(cb => cb
        .addOption('rebase', t('settings.pullStrategyRebase'))
        .addOption('merge', t('settings.pullStrategyMerge'))
        .setValue(this.plugin.settings.pullStrategy)
        .onChange(async (value) => {
          this.plugin.settings.pullStrategy = value as 'merge' | 'rebase';
          await this.plugin.saveSettings();
        }));

    new Setting(el)
      .setName(t('settings.showNotifications'))
      .setDesc(t('settings.showNotificationsDesc'))
      .addToggle(cb => cb
        .setValue(this.plugin.settings.showNotice)
        .onChange(async (value) => {
          this.plugin.settings.showNotice = value;
          await this.plugin.saveSettings();
        }));
  }

  private renderAdvancedSettings(el: HTMLElement): void {
    new Setting(el).setName(t('settings.advanced')).setHeading();

    new Setting(el)
      .setName(t('settings.debugMode'))
      .setDesc(t('settings.debugModeDesc'))
      .addToggle(cb => cb
        .setValue(this.plugin.settings.debug)
        .onChange(async (value) => {
          this.plugin.settings.debug = value;
          await this.plugin.saveSettings();
        }));
  }
}
