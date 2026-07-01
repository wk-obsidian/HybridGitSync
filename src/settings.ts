import { App, PluginSettingTab, Setting } from 'obsidian';
import type HybridGitSyncPlugin from './main';

export interface PluginSettings {
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
  backend: 'auto',
  remoteUrl: '',
  branch: 'main',
  apiProvider: 'github',
  apiToken: '',
  apiBaseUrl: '',
  gitPath: 'git',
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

    containerEl.createEl('h2', { text: 'Hybrid Git Sync Settings' });

    // Platform info
    const infoEl = containerEl.createDiv('setting-item-info');
    infoEl.createEl('span', { text: `Current platform: ${this.plugin.getPlatformName()} | Backend: ${this.plugin.getActiveBackendName()}` });
    containerEl.createEl('hr');

    this.renderBackendSettings(containerEl);
    this.renderRemoteSettings(containerEl);
    this.renderAutoSyncSettings(containerEl);
    this.renderBehaviorSettings(containerEl);
    this.renderAdvancedSettings(containerEl);
  }

  private renderBackendSettings(el: HTMLElement): void {
    el.createEl('h3', { text: 'Backend' });

    new Setting(el)
      .setName('Backend mode')
      .setDesc('Auto: desktop=git, mobile=api. Or force a specific backend.')
      .addDropdown(cb => cb
        .addOption('auto', 'Auto (recommended)')
        .addOption('git', 'Git (desktop only)')
        .addOption('api', 'API (mobile only)')
        .setValue(this.plugin.settings.backend)
        .onChange(async (value) => {
          this.plugin.settings.backend = value as PluginSettings['backend'];
          await this.plugin.saveSettings();
        }));
  }

  private renderRemoteSettings(el: HTMLElement): void {
    el.createEl('h3', { text: 'Remote Repository' });

    new Setting(el)
      .setName('Remote URL / Repo')
      .setDesc('Desktop: git remote URL. Mobile: "owner/repo" (e.g. "user/my-vault")')
      .addText(cb => cb
        .setPlaceholder('owner/repo')
        .setValue(this.plugin.settings.remoteUrl)
        .onChange(async (value) => {
          this.plugin.settings.remoteUrl = value;
          await this.plugin.saveSettings();
        }));

    new Setting(el)
      .setName('Branch')
      .setDesc('Branch to sync')
      .addText(cb => cb
        .setPlaceholder('main')
        .setValue(this.plugin.settings.branch)
        .onChange(async (value) => {
          this.plugin.settings.branch = value;
          await this.plugin.saveSettings();
        }));

    // API settings (shown on mobile or when api backend is forced)
    new Setting(el)
      .setName('API Provider')
      .setDesc('Git hosting provider for API sync')
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
      .setName('API Token')
      .setDesc('Personal Access Token for API authentication')
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
      .setName('Custom API URL')
      .setDesc('For self-hosted instances (leave empty for default)')
      .addText(cb => cb
        .setPlaceholder('https://your-gitea.com/api/v1')
        .setValue(this.plugin.settings.apiBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.apiBaseUrl = value;
          await this.plugin.saveSettings();
        }));

    // Git settings (desktop)
    new Setting(el)
      .setName('Git path')
      .setDesc('Path to git executable (desktop only)')
      .addText(cb => cb
        .setPlaceholder('git')
        .setValue(this.plugin.settings.gitPath)
        .onChange(async (value) => {
          this.plugin.settings.gitPath = value;
          await this.plugin.saveSettings();
        }));
  }

  private renderAutoSyncSettings(el: HTMLElement): void {
    el.createEl('h3', { text: 'Auto Sync' });

    new Setting(el)
      .setName('Enable auto sync')
      .setDesc('Automatically sync at regular intervals')
      .addToggle(cb => cb
        .setValue(this.plugin.settings.autoSync)
        .onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        }));

    new Setting(el)
      .setName('Sync interval')
      .setDesc('Minutes between auto syncs')
      .addText(cb => cb
        .setPlaceholder('10')
        .setValue(String(this.plugin.settings.autoSyncInterval))
        .onChange(async (value) => {
          this.plugin.settings.autoSyncInterval = parseInt(value) || 10;
          await this.plugin.saveSettings();
        }));

    new Setting(el)
      .setName('Sync on startup')
      .setDesc('Sync when Obsidian starts')
      .addToggle(cb => cb
        .setValue(this.plugin.settings.syncOnStartup)
        .onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        }));

    new Setting(el)
      .setName('Sync on file change')
      .setDesc('Trigger sync when files are modified')
      .addToggle(cb => cb
        .setValue(this.plugin.settings.syncOnFileChange)
        .onChange(async (value) => {
          this.plugin.settings.syncOnFileChange = value;
          await this.plugin.saveSettings();
        }));

    new Setting(el)
      .setName('File change debounce')
      .setDesc('Seconds to wait after last change before syncing')
      .addText(cb => cb
        .setPlaceholder('30')
        .setValue(String(this.plugin.settings.fileChangeDebounce))
        .onChange(async (value) => {
          this.plugin.settings.fileChangeDebounce = parseInt(value) || 30;
          await this.plugin.saveSettings();
        }));
  }

  private renderBehaviorSettings(el: HTMLElement): void {
    el.createEl('h3', { text: 'Behavior' });

    new Setting(el)
      .setName('Commit message')
      .setDesc('Template for commit messages. {{date}} = current datetime')
      .addText(cb => cb
        .setPlaceholder('vault backup: {{date}}')
        .setValue(this.plugin.settings.commitMessage)
        .onChange(async (value) => {
          this.plugin.settings.commitMessage = value;
          await this.plugin.saveSettings();
        }));

    new Setting(el)
      .setName('Pull strategy')
      .setDesc('How to integrate remote changes')
      .addDropdown(cb => cb
        .addOption('rebase', 'Rebase (recommended)')
        .addOption('merge', 'Merge')
        .setValue(this.plugin.settings.pullStrategy)
        .onChange(async (value) => {
          this.plugin.settings.pullStrategy = value as 'merge' | 'rebase';
          await this.plugin.saveSettings();
        }));

    new Setting(el)
      .setName('Show notifications')
      .setDesc('Show notice on sync success/failure')
      .addToggle(cb => cb
        .setValue(this.plugin.settings.showNotice)
        .onChange(async (value) => {
          this.plugin.settings.showNotice = value;
          await this.plugin.saveSettings();
        }));
  }

  private renderAdvancedSettings(el: HTMLElement): void {
    el.createEl('h3', { text: 'Advanced' });

    new Setting(el)
      .setName('Debug mode')
      .setDesc('Enable verbose logging in developer console')
      .addToggle(cb => cb
        .setValue(this.plugin.settings.debug)
        .onChange(async (value) => {
          this.plugin.settings.debug = value;
          await this.plugin.saveSettings();
        }));
  }
}
