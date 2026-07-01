import { Notice, Plugin } from 'obsidian';
import { PluginSettings, SettingsTab, DEFAULT_SETTINGS } from './settings';
import { SyncBackend } from './backend/base';
import { GitBackend } from './backend/git-backend';
import { ApiBackend, ApiProvider } from './backend/api-backend';
import { StatusBar } from './ui/status-bar';
import { getPlatformType, getPlatformName, isDesktop } from './utils/platform';

export default class HybridGitSyncPlugin extends Plugin {
  settings!: PluginSettings;
  backend!: SyncBackend;
  statusBar!: StatusBar;
  private autoSyncInterval: number | null = null;
  private fileChangeTimeout: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Initialize UI
    this.statusBar = new StatusBar(this.addStatusBarItem());
    this.addSettingTab(new SettingsTab(this.app, this));

    // Initialize backend
    await this.initBackend();

    // Register commands
    this.registerCommands();

    // Register ribbon icon
    this.addRibbonIcon('sync', 'Hybrid Git Sync', async () => {
      await this.performSync();
    });

    // Setup auto sync
    this.setupAutoSync();

    // Sync on startup
    if (this.settings.syncOnStartup) {
      // Delay a bit to let Obsidian finish loading
      setTimeout(() => this.performSync(), 5000);
    }

    this.log('Plugin loaded', `Platform: ${getPlatformName()}, Backend: ${this.getActiveBackendName()}`);
  }

  onunload(): void {
    this.stopAutoSync();
    this.backend?.dispose();
    this.log('Plugin unloaded');
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Re-init backend when settings change
    await this.initBackend();
  }

  // ===== Backend Management =====

  private async initBackend(): Promise<void> {
    this.backend?.dispose();

    const platform = getPlatformType();
    const useBackend = this.settings.backend === 'auto'
      ? (platform === 'desktop' ? 'git' : 'api')
      : this.settings.backend;

    if (useBackend === 'git') {
      if (!isDesktop()) {
        this.showNotice('Git backend is not available on mobile. Using API backend.');
        this.backend = this.createApiBackend();
      } else {
        // Convert "owner/repo" to full GitHub URL for git remote
        let remoteUrl = this.settings.remoteUrl;
        if (remoteUrl && !remoteUrl.startsWith('http') && !remoteUrl.startsWith('git@')) {
          remoteUrl = `https://github.com/${remoteUrl}.git`;
        }
        this.backend = new GitBackend(this.app.vault, this.settings.gitPath, remoteUrl, this.settings.apiToken);
      }
    } else {
      this.backend = this.createApiBackend();
    }

    // Check availability (don't show error on initial load, only on sync attempt)
    const available = await this.backend.isAvailable();
    if (!available) {
      this.statusBar.setState('idle', 'Not configured');
      this.log('Backend not available, will check again on sync');
    }
  }

  private createApiBackend(): ApiBackend {
    return new ApiBackend({
      provider: this.settings.apiProvider as ApiProvider,
      token: this.settings.apiToken,
      repo: this.settings.remoteUrl,
      branch: this.settings.branch,
      baseUrl: this.settings.apiBaseUrl || undefined,
    });
  }

  // ===== Sync Operations =====

  async performSync(): Promise<void> {
    if (!this.settings.remoteUrl) {
      this.showNotice('Please configure remote repository in settings.');
      return;
    }

    // Check backend availability before sync
    const available = await this.backend.isAvailable();
    if (!available) {
      this.statusBar.setState('error', 'Backend not available');
      this.showNotice(`${this.backend.name} backend is not available. Check settings or initialize git repo.`);
      return;
    }

    this.statusBar.setState('syncing');
    this.log('Starting sync...');

    try {
      const result = await this.backend.sync();

      if (result.success) {
        this.statusBar.setState('idle');
        this.log('Sync completed', result.message);
        if (this.settings.showNotice) {
          this.showNotice('Sync completed');
        }
      } else {
        this.statusBar.setState('error', result.message);
        this.showNotice(`Sync failed: ${result.message}`);
        this.log('Sync failed', result.message);
      }
    } catch (error) {
      this.statusBar.setState('error', (error as Error).message);
      this.showNotice(`Sync error: ${(error as Error).message}`);
      this.log('Sync error', error);
    }
  }

  // ===== Auto Sync =====

  private setupAutoSync(): void {
    this.stopAutoSync();

    if (this.settings.autoSync) {
      const intervalMs = this.settings.autoSyncInterval * 60 * 1000;
      this.autoSyncInterval = window.setInterval(() => {
        this.performSync();
      }, intervalMs);
      this.registerInterval(this.autoSyncInterval);
    }

    if (this.settings.syncOnFileChange) {
      this.registerEvent(
        this.app.vault.on('modify', () => this.onFileChange())
      );
      this.registerEvent(
        this.app.vault.on('create', () => this.onFileChange())
      );
      this.registerEvent(
        this.app.vault.on('delete', () => this.onFileChange())
      );
    }
  }

  private stopAutoSync(): void {
    if (this.autoSyncInterval !== null) {
      window.clearInterval(this.autoSyncInterval);
      this.autoSyncInterval = null;
    }
  }

  private onFileChange(): void {
    if (this.fileChangeTimeout !== null) {
      window.clearTimeout(this.fileChangeTimeout);
    }
    this.fileChangeTimeout = window.setTimeout(() => {
      this.performSync();
      this.fileChangeTimeout = null;
    }, this.settings.fileChangeDebounce * 1000);
  }

  // ===== Commands =====

  private registerCommands(): void {
    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => this.performSync(),
    });

    this.addCommand({
      id: 'pull',
      name: 'Pull',
      callback: async () => {
        this.statusBar.setState('syncing');
        const result = await this.backend.pull();
        if (result.success) {
          this.statusBar.setState('idle');
          this.showNotice('Pull completed');
        } else {
          this.statusBar.setState('error', result.message);
          this.showNotice(`Pull failed: ${result.message}`);
        }
      },
    });

    this.addCommand({
      id: 'push',
      name: 'Push',
      callback: async () => {
        this.statusBar.setState('syncing');
        const result = await this.backend.push();
        if (result.success) {
          this.statusBar.setState('idle');
          this.showNotice('Push completed');
        } else {
          this.statusBar.setState('error', result.message);
          this.showNotice(`Push failed: ${result.message}`);
        }
      },
    });

    this.addCommand({
      id: 'view-status',
      name: 'View sync status',
      callback: async () => {
        const status = await this.backend.status();
        const msg = [
          `Branch: ${status.branch}`,
          `Ahead: ${status.ahead}, Behind: ${status.behind}`,
          `Changed files: ${status.changedFiles.length}`,
          status.hasConflicts ? '⚠ Has conflicts' : 'No conflicts',
        ].join('\n');
        this.showNotice(msg, 10000);
      },
    });
  }

  // ===== Helpers =====

  getActiveBackendName(): string {
    return this.backend?.name || 'not initialized';
  }

  getPlatformName(): string {
    return getPlatformName();
  }

  private showNotice(message: string, timeout?: number): void {
    new Notice(message, timeout);
  }

  private log(...args: any[]): void {
    if (this.settings.debug) {
      console.log('[HybridGitSync]', ...args);
    }
  }
}
