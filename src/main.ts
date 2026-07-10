import { Notice, Plugin } from 'obsidian';
import { PluginSettings, SettingsTab, DEFAULT_SETTINGS } from './settings';
import { getErrorMessage } from './utils/error';
import { SyncBackend } from './backend/base';
import { GitBackend } from './backend/git-backend';
import { ApiBackend, ApiProvider } from './backend/api-backend';
import { StatusBar } from './ui/status-bar';
import { ConflictModal } from './ui/conflict-modal';
import { HistoryView, HISTORY_VIEW_TYPE } from './ui/history-view';
import { DiffView, DIFF_VIEW_TYPE } from './ui/diff-view';
import { ChangesView, CHANGES_VIEW_TYPE } from './ui/changes-view';
import { ConflictResolver, ConflictInfo } from './sync/conflict';
import { SyncQueue } from './sync/queue';
import { NetworkStatus } from './utils/network';
import { GitignoreRules } from './utils/gitignore';
import { Logger, LogLevel } from './utils/logger';
import { SettingsIO } from './utils/settings-io';
import { getPlatformName } from './utils/platform';
import { t, initI18n } from './i18n';

export default class HybridGitSyncPlugin extends Plugin {
  settings!: PluginSettings;
  backend!: SyncBackend;
  statusBar!: StatusBar;
  syncQueue!: SyncQueue;
  network!: NetworkStatus;
  gitignore!: GitignoreRules;
  logger!: Logger;
  settingsIO!: SettingsIO;
  private autoSyncInterval: number | null = null;
  private isResolvingConflicts = false;
  private pauseFileChangeSync = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Initialize i18n (auto-detect from Obsidian locale)
    initI18n();

    // Initialize utilities
    this.logger = new Logger('HybridGitSync', this.settings.debug ? LogLevel.DEBUG : LogLevel.INFO);
    this.settingsIO = new SettingsIO(this.app.vault);
    this.syncQueue = new SyncQueue(this.settings.fileChangeDebounce * 1000);
    this.network = new NetworkStatus();
    this.gitignore = new GitignoreRules();

    // Initialize UI
    this.statusBar = new StatusBar(this.addStatusBarItem());
    this.addSettingTab(new SettingsTab(this.app, this));

    // Register views
    this.registerView(HISTORY_VIEW_TYPE, (leaf) => new HistoryView(leaf));
    this.registerView(DIFF_VIEW_TYPE, (leaf) => new DiffView(leaf));
    this.registerView(CHANGES_VIEW_TYPE, (leaf) => new ChangesView(leaf));

    // Initialize backend
    try {
      await this.initBackend();
    } catch (error) {
      console.error('[HybridGitSync] Failed to initialize backend:', error);
      this.showNotice(t('notice.initFailed'));
    }

    // Load gitignore rules
    await this.loadGitignoreRules();

    // Register commands
    this.registerCommands();

    // Register ribbon icons
    this.addRibbonIcon('sync', 'Sync Now', async () => {
      await this.performSync();
    });

    // Only show history and changes icons in API mode
    if (this.backend instanceof ApiBackend) {
      this.addRibbonIcon('history', 'View History', () => {
        void this.showHistoryView();
      });

      this.addRibbonIcon('git-branch', 'View Changes', () => {
        void this.showChangesView();
      });
    }

    // Setup auto sync
    this.setupAutoSync();

    // Listen for network status changes
    this.network.onChange(online => {
      if (online) {
        this.log('Network restored, triggering sync');
        void this.performSync();
      } else {
        this.statusBar.setState('offline');
      }
    });

    // Sync on startup
    if (this.settings.syncOnStartup && this.network.isOnline()) {
      window.setTimeout(() => this.performSync(), 5000);
    }

    this.log('Plugin loaded', `Platform: ${getPlatformName()}, Backend: ${this.getActiveBackendName()}`);
  }

  onunload(): void {
    this.stopAutoSync();
    this.syncQueue?.clear();
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

    // Determine backend mode
    let useBackend = this.settings.backend;

    if (useBackend === 'auto') {
      // Auto mode: check if git is available
      useBackend = await this.isGitAvailable() ? 'git' : 'api';
      this.log('Auto mode: using', useBackend, 'backend');
    }

    if (useBackend === 'git') {
      // Verify git is actually available
      const gitAvailable = await this.isGitAvailable();
      if (!gitAvailable) {
        this.showNotice(t('notice.gitNotAvailable'));
        this.backend = this.createApiBackend();
      } else {
        let remoteUrl = this.settings.remoteUrl;
        if (remoteUrl && !remoteUrl.startsWith('http') && !remoteUrl.startsWith('git@')) {
          remoteUrl = `https://github.com/${remoteUrl}.git`;
        }
        this.backend = new GitBackend(this.app.vault, this.settings.gitPath, remoteUrl, this.settings.apiToken);

        // Auto-detect remote info if not configured
        if (!this.settings.remoteUrl) {
          const gitBackend = this.backend as GitBackend;
          const repoInfo = await gitBackend.getRepoInfo();
          if (repoInfo.remoteUrl) {
            this.settings.remoteUrl = repoInfo.remoteUrl;
            this.log('Auto-detected remote URL:', repoInfo.remoteUrl);
          }
          if (repoInfo.branch) {
            this.settings.branch = repoInfo.branch;
            this.log('Auto-detected branch:', repoInfo.branch);
          }
          if (repoInfo.remoteUrl || repoInfo.branch) {
            await this.saveSettings();
            this.showNotice(t('notice.gitAutoDetected'));
          }
        }
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
    if (this.backend instanceof ApiBackend) {
      const correctedBranch = this.backend.getBranch();
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
    }, this.gitignore, this.settings.debug);
  }

  /**
   * Check if git is available and vault is a git repository
   */
  private async isGitAvailable(): Promise<boolean> {
    try {
      // Create a temporary GitBackend to check availability
      const tempBackend = new GitBackend(this.app.vault, this.settings.gitPath);
      return await tempBackend.isAvailable();
    } catch {
      return false;
    }
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
        this.showNotice(t('notice.gitignoreCreated'));
      } catch (error) {
        console.error('[HybridGitSync] Failed to create .gitignore:', error);
        // Fallback to built-in patterns
        this.gitignore.useBuiltInPatterns();
      }
    }
  }

  // ===== Sync Operations =====

  async performSync(): Promise<void> {
    console.log('[HybridGitSync] performSync called');

    // Don't sync while resolving conflicts
    if (this.isResolvingConflicts) {
      console.log('[HybridGitSync] Sync skipped: resolving conflicts');
      return;
    }

    if (!this.settings.remoteUrl) {
      console.log('[HybridGitSync] Sync skipped: no remote URL');
      this.showNotice(t('sync.skipped.noRemote'));
      return;
    }

    if (!this.network.isOnline()) {
      console.log('[HybridGitSync] Sync skipped: offline');
      this.statusBar.setState('offline');
      this.showNotice(t('sync.skipped.offline'));
      return;
    }

    // Check if backend is initialized
    if (!this.backend) {
      console.log('[HybridGitSync] Sync skipped: backend not initialized');
      this.statusBar.setState('error', 'Backend not initialized');
      this.showNotice(t('sync.skipped.backendNotInitialized'));
      return;
    }

    // Check backend availability
    console.log('[HybridGitSync] Checking backend availability...');
    const available = await this.backend.isAvailable();
    if (!available) {
      console.log('[HybridGitSync] Sync skipped: backend not available');
      this.statusBar.setState('error', 'Backend not available');
      this.showNotice(t('sync.skipped.backendNotAvailable', { backend: this.backend.name }));
      return;
    }

    // Use sync queue with debouncing
    console.log('[HybridGitSync] Enqueuing sync operation...');
    this.syncQueue.enqueue(async () => {
      this.log('Sync queue callback executing', {
        hasBackend: !!this.backend,
        backendType: this.backend?.constructor?.name,
      });
      this.statusBar.setState('syncing');
      this.log('Starting sync...');

      try {
        // If using API backend, check for conflicts first
        if (this.backend instanceof ApiBackend) {
          const conflicts = await this.checkConflicts();
          if (conflicts.length > 0) {
            this.statusBar.setState('conflict');
            await this.handleConflicts(conflicts);
            return;
          }
        }

        const result = await this.backend.sync();

        if (result.success) {
          this.statusBar.setState('idle');
          this.log('Sync completed', result.message);
          if (this.settings.showNotice) {
            this.showNotice(result.message || 'Sync completed');
          }
        } else {
          this.statusBar.setState('error', result.message);
          this.showNotice(`Sync failed: ${result.message}`);
          this.log('Sync failed', result.message);
        }
      } catch (error) {
        this.statusBar.setState('error', getErrorMessage(error));
        this.showNotice(`Sync error: ${getErrorMessage(error)}`);
        this.log('Sync error', error);
      }
    });
  }

  /**
   * Check for conflicts before syncing
   * Only returns conflicts where BOTH sides have changed since last sync
   */
  private async checkConflicts(): Promise<ConflictInfo[]> {
    if (!(this.backend instanceof ApiBackend)) return [];

    const apiBackend = this.backend as ApiBackend;
    const stateManager = apiBackend.getStateManager();

    // Load sync state
    await stateManager.load();
    const knownFiles = stateManager.getKnownFiles();

    // If no sync state, no conflicts possible (first sync)
    if (knownFiles.size === 0) return [];

    // Get cached remote SHAs
    const cachedRemoteShas = stateManager.getAllRemoteShas();
    if (cachedRemoteShas.size === 0) return [];

    const conflicts: ConflictInfo[] = [];

    // Get current remote file tree
    const remoteMap = await apiBackend.getRemoteTree();

    // Check each known file
    for (const [path, storedHash] of knownFiles) {
      if (this.gitignore.shouldIgnore(path)) continue;

      const remoteSha = remoteMap.get(path);
      const cachedSha = cachedRemoteShas.get(path);

      // Skip if file doesn't exist on remote or no cached SHA
      if (!remoteSha || !cachedSha) continue;

      // Check if remote changed
      const remoteChanged = remoteSha !== cachedSha;
      if (!remoteChanged) continue;

      // Remote changed - check if local also changed
      try {
        const localContent = await this.app.vault.adapter.read(path);
        const localHash = await apiBackend.gitBlobSha1(localContent);
        const localChanged = localHash !== storedHash;

        if (localChanged) {
          // Both sides changed - this is a real conflict
          const remoteFile = await apiBackend.getFile(path);
          if (remoteFile && localContent !== remoteFile.content) {
            conflicts.push({
              path,
              localContent,
              remoteContent: remoteFile.content,
              localModified: new Date(),
              remoteModified: new Date(),
            });
          }
        }
      } catch {
        // Ignore errors
      }
    }

    return conflicts;
  }

  /**
   * Handle conflicts by showing the conflict resolution modal
   * Only shows one modal at a time, pauses sync queue
   */
  private async handleConflicts(conflicts: ConflictInfo[]): Promise<void> {
    // Set flag to prevent sync while resolving
    this.isResolvingConflicts = true;
    this.pauseFileChangeSync = true;
    this.syncQueue.clear();
    this.statusBar.setState('conflict', `${conflicts.length} conflict(s)`);

    // Get the stateManager from the API backend
    const apiBackend = this.backend as ApiBackend;
    const stateManager = apiBackend.getStateManager();
    const resolver = new ConflictResolver(this.app.vault, apiBackend, stateManager);

    // Process conflicts one at a time
    let current = 0;
    const processNext = () => {
      if (current >= conflicts.length) {
        // All conflicts resolved - save state to disk
        void stateManager.save().then(() => {
          this.isResolvingConflicts = false;
          this.pauseFileChangeSync = false;
          this.showNotice(t('notice.conflictsResolved'));
          void this.performSync();
        });
        return;
      }

      const conflict = conflicts[current];
      const diff = resolver.generateDiff(conflict.localContent, conflict.remoteContent);

      new ConflictModal(this.app, conflict, diff, async (resolution) => {
        await resolver.resolve(conflict, resolution);
        this.showNotice(t('notice.conflictResolved', { path: conflict.path, resolution }));
        current++;
        processNext();
      }).open();
    };

    processNext();
  }

  // ===== Auto Sync =====

  private setupAutoSync(): void {
    this.stopAutoSync();

    if (this.settings.autoSync) {
      const intervalMs = this.settings.autoSyncInterval * 60 * 1000;
      this.autoSyncInterval = window.setInterval(() => {
        if (this.network.isOnline()) {
          void this.performSync();
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
    if (this.pauseFileChangeSync) {
      this.log('File change sync paused');
      return;
    }
    this.syncQueue.enqueue(() => void this.performSync());
  }

  // ===== Commands =====

  private async pullCommand(): Promise<void> {
    if (!this.network.isOnline()) {
      this.showNotice(t('notice.offline'));
      return;
    }
    this.statusBar.setState('syncing');
    const result = await this.backend.pull();
    if (result.success) {
      this.statusBar.setState('idle');
      this.showNotice(t('notice.pullCompleted'));
    } else {
      this.statusBar.setState('error', result.message);
      this.showNotice(t('notice.pullFailed', { message: result.message }));
    }
  }

  private async pushCommand(): Promise<void> {
    if (!this.network.isOnline()) {
      this.showNotice(t('notice.offline'));
      return;
    }
    this.statusBar.setState('syncing');
    const result = await this.backend.push();
    if (result.success) {
      this.statusBar.setState('idle');
      this.showNotice(t('notice.pushCompleted'));
    } else {
      this.statusBar.setState('error', result.message);
      this.showNotice(t('notice.pushFailed', { message: result.message }));
    }
  }

  private async viewStatusCommand(): Promise<void> {
    const status = await this.backend.status();
    const msg = [
      `Branch: ${status.branch}`,
      `Ahead: ${status.ahead}, Behind: ${status.behind}`,
      `Changed files: ${status.changedFiles.length}`,
      status.hasConflicts ? '⚠ Has conflicts' : 'No conflicts',
      `Network: ${this.network.isOnline() ? 'Online' : 'Offline'}`,
    ].join('\n');
    this.showNotice(msg, 10000);
  }

  private async toggleAutoSyncCommand(): Promise<void> {
    this.settings.autoSync = !this.settings.autoSync;
    await this.saveSettings();
    this.showNotice(t('notice.autoSyncToggled', { status: this.settings.autoSync ? t('notice.autoSyncEnabled') : t('notice.autoSyncDisabled') }));
  }

  private registerCommands(): void {
    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => void this.performSync(),
    });

    this.addCommand({
      id: 'pull',
      name: 'Pull',
      callback: () => void this.pullCommand(),
    });

    this.addCommand({
      id: 'push',
      name: 'Push',
      callback: () => void this.pushCommand(),
    });

    this.addCommand({
      id: 'view-status',
      name: 'View sync status',
      callback: () => void this.viewStatusCommand(),
    });

    this.addCommand({
      id: 'toggle-auto-sync',
      name: 'Toggle auto sync',
      callback: () => void this.toggleAutoSyncCommand(),
    });

    this.addCommand({
      id: 'view-history',
      name: 'View commit history',
      callback: () => void this.showHistoryView(),
    });

    this.addCommand({
      id: 'view-changes',
      name: 'View changes',
      callback: () => void this.showChangesView(),
    });

    this.addCommand({
      id: 'diff-current-file',
      name: 'Diff current file',
      callback: () => void this.diffCurrentFile(),
    });

    this.addCommand({
      id: 'restore-file',
      name: 'Restore file from remote',
      callback: () => void this.restoreCurrentFile(),
    });

    this.addCommand({
      id: 'switch-branch',
      name: 'Switch branch',
      callback: () => void this.switchBranch(),
    });

    this.addCommand({
      id: 'view-logs',
      name: 'View logs',
      callback: () => this.showLogs(),
    });

    this.addCommand({
      id: 'export-settings',
      name: 'Export settings',
      callback: () => this.exportSettings(),
    });

    this.addCommand({
      id: 'import-settings',
      name: 'Import settings',
      callback: () => void this.importSettings(),
    });

    this.addCommand({
      id: 'clear-sync-state',
      name: 'Clear sync state',
      callback: () => void this.clearSyncState(),
    });
  }

  // ===== Logs =====

  private showLogs(): void {
    const logs = this.logger.getLogsAsString();
    new Notice(t('notice.logsCopied'), 5000);
    navigator.clipboard.writeText(logs);
  }

  // ===== Settings Import/Export =====

  private async exportSettings(): Promise<void> {
    await this.settingsIO.exportSettings(this.settings);
    this.showNotice(t('notice.settingsExported'));
  }

  private async importSettings(): Promise<void> {
    const imported = await this.settingsIO.importSettings();
    if (imported) {
      this.settings = { ...this.settings, ...imported };
      await this.saveSettings();
      this.showNotice(t('notice.settingsImported'));
    } else {
      this.showNotice(t('notice.settingsImportFailed'));
    }
  }

  // ===== Sync State =====

  private async clearSyncState(): Promise<void> {
    if (this.backend instanceof ApiBackend) {
      const stateManager = (this.backend as ApiBackend).getStateManager();
      stateManager.clear();
      await stateManager.save();
      this.showNotice(t('notice.syncStateCleared'));
    }
  }

  // ===== Version Restore =====

  private async restoreCurrentFile(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      this.showNotice(t('notice.noActiveFile'));
      return;
    }

    if (!(this.backend instanceof ApiBackend)) {
      this.showNotice(t('notice.restoreApiOnly'));
      return;
    }

    const remoteFile = await (this.backend as ApiBackend).getFile(activeFile.path);
    if (!remoteFile) {
      this.showNotice(t('notice.fileNotFound'));
      return;
    }

    await this.app.vault.adapter.write(activeFile.path, remoteFile.content);
    this.showNotice(t('notice.fileRestored', { path: activeFile.path }));
  }

  // ===== Branch Management =====

  private async switchBranch(): Promise<void> {
    if (!(this.backend instanceof ApiBackend)) {
      this.showNotice('Branch switching is only available in API mode');
      return;
    }

    const branches = await (this.backend as ApiBackend).getBranches();
    if (branches.length === 0) {
      this.showNotice('No branches found');
      return;
    }

    // Show branch selection
    const currentBranch = (this.backend as ApiBackend).getBranch();
    new Notice(`Branches:\n${branches.map(b =>
      `${b === currentBranch ? '● ' : '  '}${b}`
    ).join('\n')}\n\nCurrent: ${currentBranch}`, 10000);
  }

  // ===== Views =====

  private async showHistoryView(): Promise<void> {
    if (!(this.backend instanceof ApiBackend)) {
      this.showNotice('History view is only available in API mode');
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;

    await leaf.setViewState({ type: HISTORY_VIEW_TYPE });
    const view = leaf.view as HistoryView;

    // Load commit history
    const commits = await (this.backend as ApiBackend).getCommitHistory();
    view.setCommits(commits);

    view.onCommitSelected(async (commit) => {
      const details = await (this.backend as ApiBackend).getCommitDetails(commit.sha);
      if (details) {
        view.setCommits([details, ...commits.filter(c => c.sha !== commit.sha)]);
      }
    });
  }

  private async showChangesView(): Promise<void> {
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;

    await leaf.setViewState({ type: CHANGES_VIEW_TYPE });
    const view = leaf.view as ChangesView;

    // Load current changes
    const status = await this.backend.status();
    view.setChanges(status.changedFiles);

    view.onFileClicked((path) => {
      this.diffFile(path);
    });
  }

  private async diffCurrentFile(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      this.showNotice('No active file');
      return;
    }
    await this.diffFile(activeFile.path);
  }

  private async diffFile(path: string): Promise<void> {
    if (!(this.backend instanceof ApiBackend)) {
      this.showNotice('Diff view is only available in API mode');
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;

    await leaf.setViewState({ type: DIFF_VIEW_TYPE });
    const view = leaf.view as DiffView;

    // Get local content
    let localContent = '';
    try {
      localContent = await this.app.vault.adapter.read(path);
    } catch { /* file may not exist locally */ }

    // Get remote content
    const remoteFile = await (this.backend as ApiBackend).getFile(path);
    const remoteContent = remoteFile?.content || '';

    view.setDiff(path, remoteContent, localContent);
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

  private log(...args: unknown[]): void {
    if (this.settings.debug) {
      console.log('[HybridGitSync]', ...args);
    }
  }
}
