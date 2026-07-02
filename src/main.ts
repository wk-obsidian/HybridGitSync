import { Notice, Plugin } from 'obsidian';
import { PluginSettings, SettingsTab, DEFAULT_SETTINGS } from './settings';
import { SyncBackend } from './backend/base';
import { GitBackend } from './backend/git-backend';
import { ApiBackend, ApiProvider } from './backend/api-backend';
import { StatusBar } from './ui/status-bar';
import { ConflictModal } from './ui/conflict-modal';
import { ConflictResolver, ConflictInfo } from './sync/conflict';
import { SyncQueue } from './sync/queue';
import { NetworkStatus } from './utils/network';
import { GitignoreRules } from './utils/gitignore';
import { getPlatformType, getPlatformName, isDesktop } from './utils/platform';

export default class HybridGitSyncPlugin extends Plugin {
  settings!: PluginSettings;
  backend!: SyncBackend;
  statusBar!: StatusBar;
  syncQueue!: SyncQueue;
  network!: NetworkStatus;
  gitignore!: GitignoreRules;
  private autoSyncInterval: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Initialize utilities
    this.syncQueue = new SyncQueue(this.settings.fileChangeDebounce * 1000);
    this.network = new NetworkStatus();
    this.gitignore = new GitignoreRules();

    // Initialize UI
    this.statusBar = new StatusBar(this.addStatusBarItem());
    this.addSettingTab(new SettingsTab(this.app, this));

    // Initialize backend
    try {
      await this.initBackend();
    } catch (error) {
      console.error('[HybridGitSync] Failed to initialize backend:', error);
      this.showNotice('Failed to initialize sync backend. Check settings.');
    }

    // Load gitignore rules
    await this.loadGitignoreRules();

    // Register commands
    this.registerCommands();

    // Register ribbon icon
    this.addRibbonIcon('sync', 'Hybrid Git Sync', async () => {
      await this.performSync();
    });

    // Setup auto sync
    this.setupAutoSync();

    // Listen for network status changes
    this.network.onChange(online => {
      if (online) {
        this.log('Network restored, triggering sync');
        this.performSync();
      } else {
        this.statusBar.setState('offline');
      }
    });

    // Sync on startup
    if (this.settings.syncOnStartup && this.network.isOnline()) {
      setTimeout(() => this.performSync(), 5000);
    }

    this.log('Plugin loaded', `Platform: ${getPlatformName()}, Backend: ${this.getActiveBackendName()}`);
  }

  onunload(): void {
    this.stopAutoSync();
    this.syncQueue.clear();
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
    // Update sync queue debounce
    this.syncQueue.setDebounceMs(this.settings.fileChangeDebounce * 1000);
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
        let remoteUrl = this.settings.remoteUrl;
        if (remoteUrl && !remoteUrl.startsWith('http') && !remoteUrl.startsWith('git@')) {
          remoteUrl = `https://github.com/${remoteUrl}.git`;
        }
        this.backend = new GitBackend(this.app.vault, this.settings.gitPath, remoteUrl, this.settings.apiToken);
      }
    } else {
      this.backend = this.createApiBackend();
    }

    // Check availability
    const available = await this.backend.isAvailable();
    if (!available) {
      this.statusBar.setState('idle', 'Not configured');
      this.log('Backend not available, will check again on sync');
    }

    // Save corrected branch if using API backend
    if ('getBranch' in this.backend) {
      const correctedBranch = (this.backend as any).getBranch();
      if (correctedBranch !== this.settings.branch) {
        this.settings.branch = correctedBranch;
        await this.saveSettings();
      }
    }
  }

  private createApiBackend(): ApiBackend {
    return new ApiBackend(this.app.vault, {
      provider: this.settings.apiProvider as ApiProvider,
      token: this.settings.apiToken,
      repo: this.settings.remoteUrl,
      branch: this.settings.branch,
      baseUrl: this.settings.apiBaseUrl || undefined,
    }, this.gitignore);
  }

  // ===== Gitignore =====

  private async loadGitignoreRules(): Promise<void> {
    try {
      const content = await this.app.vault.adapter.read('.gitignore');
      this.gitignore.addRules(content);
      this.log('Loaded .gitignore rules');
    } catch {
      // No .gitignore file - create one with default rules
      this.log('No .gitignore found, creating with default rules');
      const defaultContent = this.gitignore.getDefaultContent();
      try {
        await this.app.vault.adapter.write('.gitignore', defaultContent);
        this.gitignore.addRules(defaultContent);
        this.showNotice('Created .gitignore with default rules');
      } catch (error) {
        console.error('[HybridGitSync] Failed to create .gitignore:', error);
        // Fallback to built-in patterns
        this.gitignore.useBuiltInPatterns();
      }
    }
  }

  // ===== Sync Operations =====

  async performSync(): Promise<void> {
    this.log('performSync called', {
      hasSettings: !!this.settings,
      hasBackend: !!this.backend,
      hasNetwork: !!this.network,
      hasStatusBar: !!this.statusBar,
    });

    if (!this.settings.remoteUrl) {
      this.showNotice('Please configure remote repository in settings.');
      return;
    }

    if (!this.network.isOnline()) {
      this.statusBar.setState('offline');
      this.showNotice('Offline. Sync will resume when network is available.');
      return;
    }

    // Check if backend is initialized
    if (!this.backend) {
      this.statusBar.setState('error', 'Backend not initialized');
      this.showNotice('Backend not initialized. Please check settings.');
      return;
    }

    // Check backend availability
    const available = await this.backend.isAvailable();
    if (!available) {
      this.statusBar.setState('error', 'Backend not available');
      this.showNotice(`${this.backend.name} backend is not available. Check settings.`);
      return;
    }

    // Use sync queue with debouncing
    const self = this;
    this.syncQueue.enqueue(async () => {
      self.log('Sync queue callback executing', {
        hasBackend: !!self.backend,
        backendType: self.backend?.constructor?.name,
      });
      self.statusBar.setState('syncing');
      self.log('Starting sync...');

      try {
        // If using API backend, check for conflicts first
        if (self.backend instanceof ApiBackend) {
          const conflicts = await self.checkConflicts();
          if (conflicts.length > 0) {
            self.statusBar.setState('conflict');
            await self.handleConflicts(conflicts);
            return;
          }
        }

        const result = await self.backend.sync();

        if (result.success) {
          self.statusBar.setState('idle');
          self.log('Sync completed', result.message);
          if (self.settings.showNotice) {
            self.showNotice(result.message || 'Sync completed');
          }
        } else {
          self.statusBar.setState('error', result.message);
          self.showNotice(`Sync failed: ${result.message}`);
          self.log('Sync failed', result.message);
        }
      } catch (error) {
        self.statusBar.setState('error', (error as Error).message);
        self.showNotice(`Sync error: ${(error as Error).message}`);
        self.log('Sync error', error);
      }
    });
  }

  /**
   * Check for conflicts before syncing
   */
  private async checkConflicts(): Promise<ConflictInfo[]> {
    if (!(this.backend instanceof ApiBackend)) return [];

    const resolver = new ConflictResolver(this.vault, this.backend);

    // Get local files
    const localFiles = new Map<string, string>();
    const listFiles = async (path: string) => {
      const listing = await this.app.vault.adapter.list(path);
      for (const file of listing.files) {
        if (!this.gitignore.shouldIgnore(file)) {
          const content = await this.app.vault.adapter.read(file);
          localFiles.set(file, content);
        }
      }
      for (const dir of listing.folders) {
        if (!this.gitignore.shouldIgnore(dir)) {
          await listFiles(dir);
        }
      }
    };
    await listFiles('');

    return resolver.detectConflicts(localFiles);
  }

  /**
   * Handle conflicts by showing the conflict resolution modal
   */
  private async handleConflicts(conflicts: ConflictInfo[]): Promise<void> {
    const resolver = new ConflictResolver(this.vault, this.backend as ApiBackend);

    for (const conflict of conflicts) {
      const diff = resolver.generateDiff(conflict.localContent, conflict.remoteContent);

      new ConflictModal(this.app, conflict, diff, async (resolution) => {
        await resolver.resolve(conflict, resolution);
        this.showNotice(`Resolved ${conflict.path}: ${resolution}`);

        // Continue sync after all conflicts resolved
        if (conflicts.indexOf(conflict) === conflicts.length - 1) {
          await this.performSync();
        }
      }).open();
    }
  }

  // ===== Auto Sync =====

  private setupAutoSync(): void {
    this.stopAutoSync();

    if (this.settings.autoSync) {
      const intervalMs = this.settings.autoSyncInterval * 60 * 1000;
      this.autoSyncInterval = window.setInterval(() => {
        if (this.network.isOnline()) {
          this.performSync();
        }
      }, intervalMs);
      this.registerInterval(this.autoSyncInterval);
    }

    if (this.settings.syncOnFileChange) {
      this.registerEvent(
        this.app.vault.on('modify', (file) => {
          if (!this.gitignore.shouldIgnore(file.path)) {
            this.onFileChange();
          }
        })
      );
      this.registerEvent(
        this.app.vault.on('create', (file) => {
          if (!this.gitignore.shouldIgnore(file.path)) {
            this.onFileChange();
          }
        })
      );
      this.registerEvent(
        this.app.vault.on('delete', (file) => {
          if (!this.gitignore.shouldIgnore(file.path)) {
            this.onFileChange();
          }
        })
      );
      this.registerEvent(
        this.app.vault.on('rename', (file) => {
          if (!this.gitignore.shouldIgnore(file.path)) {
            this.onFileChange();
          }
        })
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
    if (!this.network.isOnline()) return;
    this.syncQueue.enqueue(() => this.performSync());
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
        if (!this.network.isOnline()) {
          this.showNotice('Offline');
          return;
        }
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
        if (!this.network.isOnline()) {
          this.showNotice('Offline');
          return;
        }
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
          `Network: ${this.network.isOnline() ? 'Online' : 'Offline'}`,
        ].join('\n');
        this.showNotice(msg, 10000);
      },
    });

    this.addCommand({
      id: 'toggle-auto-sync',
      name: 'Toggle auto sync',
      callback: async () => {
        this.settings.autoSync = !this.settings.autoSync;
        await this.saveSettings();
        this.showNotice(`Auto sync ${this.settings.autoSync ? 'enabled' : 'disabled'}`);
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
