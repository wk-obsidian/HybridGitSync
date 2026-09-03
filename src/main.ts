import { EventRef, Notice, Plugin, TFile } from 'obsidian';
import { PluginSettings, SettingsTab, DEFAULT_SETTINGS, ConfirmModal } from './settings';
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
import type { DiffResult } from './utils/diff';
import { SyncQueue } from './sync/queue';
import { NetworkStatus } from './utils/network';
import { isBinaryFile } from './utils/binary';
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
  private fileChangeRefs: EventRef[] = [];
  private isResolvingConflicts = false;
  private pauseFileChangeSync = false;
  // Remote-reset prompt state: throttle repeat prompts (auto-sync and
  // file-change triggers fire often) and prevent concurrent duplicates
  private lastResetPromptAt = 0;
  private resetPromptActive = false;
  private readonly RESET_PROMPT_INTERVAL_MS = 10 * 60 * 1000;

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
        // Only resume sync on network restore if an auto-sync mode is enabled
        if (this.settings.autoSync || this.settings.syncOnFileChange) {
          this.log('Network restored, triggering sync');
          void this.performSync();
        }
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
    // Re-apply auto sync config (interval and file-change listeners)
    this.setupAutoSync();
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
          // Use provider-specific base URL for short repo format
          if (this.settings.apiProvider === 'gitea' && this.settings.apiBaseUrl) {
            // Extract base domain from API URL (e.g., https://gitea.com/api/v1 -> gitea.com)
            const apiDomain = this.settings.apiBaseUrl.replace('/api/v1', '').replace(/\/$/, '');
            remoteUrl = `${apiDomain}/${remoteUrl}.git`;
          } else if (this.settings.apiProvider === 'gitlab') {
            remoteUrl = `https://gitlab.com/${remoteUrl}.git`;
          } else {
            remoteUrl = `https://github.com/${remoteUrl}.git`;
          }
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

    // Validate API repo format (must be "owner/repo", not a token or URL)
    if (!this.isApiRemoteUrlValid()) {
      this.showNotice(t('sync.skipped.badRemoteUrl'));
      this.statusBar.setState('idle', 'Not configured');
      this.log('Invalid remote repository format, skipping availability check');
      return;
    }

    // Check availability
    const available = await this.backend.isAvailable();
    if (!available) {
      this.statusBar.setState('idle', 'Not configured');
      this.log('Backend not available, will check again on sync');
      return;
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
      commitMessage: this.settings.commitMessage,
    }, this.gitignore, this.settings.debug);
  }

  /**
   * API mode requires the remote repository as "owner/repo" (GitLab:
   * "namespace/project"), not a full URL or token.
   */
  private isApiRemoteUrlValid(): boolean {
    if (!(this.backend instanceof ApiBackend)) return true;
    if (!this.settings.remoteUrl) return false;
    return this.settings.remoteUrl.includes('/') && !this.settings.remoteUrl.includes('://');
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
    this.log('performSync called');

    // Don't sync while resolving conflicts
    if (this.isResolvingConflicts) {
      this.log('Sync skipped: resolving conflicts');
      return;
    }

    if (!this.settings.remoteUrl) {
      this.log('Sync skipped: no remote URL');
      this.showNotice(t('sync.skipped.noRemote'));
      return;
    }

    // Validate API repo format before the availability check so the
    // notice points at the real problem instead of "backend not available"
    if (!this.isApiRemoteUrlValid()) {
      this.log('Sync skipped: invalid remote repository format');
      this.statusBar.setState('error', 'Bad remote URL');
      this.showNotice(t('sync.skipped.badRemoteUrl'));
      return;
    }

    if (!this.network.isOnline()) {
      this.log('Sync skipped: offline');
      this.statusBar.setState('offline');
      this.showNotice(t('sync.skipped.offline'));
      return;
    }

    // Check if backend is initialized
    if (!this.backend) {
      this.log('Sync skipped: backend not initialized');
      this.statusBar.setState('error', 'Backend not initialized');
      this.showNotice(t('sync.skipped.backendNotInitialized'));
      return;
    }

    // Check backend availability
    this.log('Checking backend availability...');
    const available = await this.backend.isAvailable();
    if (!available) {
      this.log('Sync skipped: backend not available');
      this.statusBar.setState('error', 'Backend not available');
      this.showNotice(t('sync.skipped.backendNotAvailable', { backend: this.backend.name }));
      return;
    }

    // Check for empty repository and initialize if needed (before sync)
    if (this.backend instanceof ApiBackend) {
      try {
        const isEmpty = await this.backend.isEmptyRepo();
        if (isEmpty) {
          const apiBackend = this.backend;
          const stateManager = apiBackend.getStateManager();
          await stateManager.load();

          // A repo we previously synced against is now empty - almost always
          // wiped and recreated. Never auto-initialize on top of a stale
          // cache: the sync engine would see every cached file as "deleted
          // remotely" and delete it locally. Ask the user first.
          if (stateManager.cachedPathCount > 0) {
            const action = await this.askRemoteResetAction(
              t('sync.reset.detectedMessage', { count: String(stateManager.cachedPathCount) })
            );
            if (action === null) {
              this.log('Sync aborted: remote repo is empty but sync state exists');
              return;
            }
            // The repo is empty, so both actions converge: clear the stale
            // cache and rebuild from local via the normal init + sync flow.
            this.log('Remote reset action chosen:', action);
            stateManager.clear();
            await stateManager.save();
          }

          this.log('Empty repository detected during sync, initializing...');
          this.showNotice(t('repo.initializing'));
          const initResult = await this.backend.initializeRepo();
          if (initResult.success) {
            this.showNotice(initResult.message);
            this.log('Repository initialized successfully');
          } else {
            this.showNotice(initResult.message);
            this.logger.warn('Repository initialization failed:', initResult.message);
            return; // Don't proceed with sync if init failed
          }
        }
      } catch (error) {
        this.logger.warn('Failed to check empty repo:', error);
      }
    }

    // Use sync queue with debouncing
    this.log('Enqueuing sync operation...');
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

        // Remote repo was reset/recreated (or the vault was pointed at a new
        // repo) - ask the user how to proceed instead of showing a generic
        // failure. Only API mode returns these codes.
        if (this.backend instanceof ApiBackend && result.code === 'remote-reset') {
          const apiBackend = this.backend;
          const stateManager = apiBackend.getStateManager();
          await stateManager.load();
          const action = await this.askRemoteResetAction(
            result.message || t('sync.reset.detectedMessage', { count: String(stateManager.cachedPathCount) })
          );
          if (action === null) {
            this.statusBar.setState('idle');
            this.log('Sync aborted by user after remote reset detection');
            return;
          }
          stateManager.clear();
          await stateManager.save();
          if (action === 'mirror') {
            // Rebuild the remote as an exact copy of the local vault
            this.log('Remote reset: rebuilding remote from local (mirror)');
            this.statusBar.setState('syncing');
            const pushResult = await apiBackend.push();
            if (pushResult.success) {
              this.statusBar.setState('idle');
              this.showNotice(t('notice.pushCompleted'));
            } else {
              this.statusBar.setState('error', pushResult.message);
              this.showNotice(t('notice.pushFailed', { message: pushResult.message }));
            }
          } else {
            // Merge: full sync with first-sync semantics (cache is now empty)
            this.log('Remote reset: re-syncing with cleared state (merge)');
            void this.performSync();
          }
          return;
        }
        if (result.code === 'unverifiable') {
          // Could not confirm the remote history - skip rather than risk it
          this.statusBar.setState('error', result.message);
          this.showNotice(result.message);
          return;
        }

        if (result.success) {
          this.statusBar.setState('idle');
          this.log('Sync completed', result.message);
          if (this.settings.showNotice) {
            this.showNotice(result.message || 'Sync completed');
          }
          // Show skipped files notification
          if (result.skipped && result.skipped.length > 0) {
            const skippedMsg = result.skipped
              .map(f => `${f.path} (${this.formatFileSize(f.size)})`)
              .join('\n');
            this.showNotice(t('sync.skippedFiles', {
              count: String(result.skipped.length),
              files: skippedMsg
            }), 10000);
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
   * Ask the user how to proceed after detecting that the remote repository
   * was reset/recreated (history unrelated to the last synced state).
   *
   * - 'mirror': rebuild the remote as an exact copy of the local vault
   * - 'merge': clear sync state and run a full sync (first-sync semantics)
   * - null: canceled, or the prompt was suppressed (already shown recently /
   *   another prompt is open) - the caller must abort the sync
   */
  private async askRemoteResetAction(message: string): Promise<'mirror' | 'merge' | null> {
    const now = Date.now();
    if (this.resetPromptActive || now - this.lastResetPromptAt < this.RESET_PROMPT_INTERVAL_MS) {
      // Auto-sync / file-change triggers fire often - do not re-prompt
      this.showNotice(t('sync.reset.skipped'));
      return null;
    }
    this.resetPromptActive = true;
    this.lastResetPromptAt = now;
    try {
      const modal = new ConfirmModal(this.app, t('sync.reset.detectedTitle'), message, [
        {
          text: t('sync.reset.mirror'),
          value: 'mirror',
          hint: t('sync.reset.mirrorHint'),
          warning: true,
        },
        {
          text: t('sync.reset.merge'),
          value: 'merge',
          hint: t('sync.reset.mergeHint'),
        },
      ]);
      const action = await modal.open();
      return action === 'mirror' || action === 'merge' ? action : null;
    } finally {
      this.resetPromptActive = false;
    }
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
    const { tree: remoteMap } = await apiBackend.getRemoteTree();

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
        const binary = isBinaryFile(path);
        let localContent: string | ArrayBuffer;
        let localHash: string;

        if (binary) {
          localContent = await this.app.vault.adapter.readBinary(path);
          localHash = await apiBackend.gitBlobSha1Binary(localContent);
        } else {
          localContent = await this.app.vault.adapter.read(path);
          localHash = await apiBackend.gitBlobSha1(localContent);
        }

        const localChanged = localHash !== storedHash;

        if (localChanged) {
          // Both sides changed - this is a real conflict
          const remoteFile = await apiBackend.getFile(path);
          if (remoteFile) {
            const isDifferent = binary
              ? (localContent as ArrayBuffer).byteLength !== (remoteFile.content as ArrayBuffer).byteLength
              : localContent !== remoteFile.content;

            if (isDifferent) {
              conflicts.push({
                path,
                localContent,
                remoteContent: remoteFile.content,
                localModified: new Date(),
                remoteModified: new Date(),
                isBinary: binary,
              });
            }
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

        if (resolution === 'merge') {
          // For merge, update sync state with current file content
          // The user has edited the file and clicked "Done"
          try {
            const file = this.app.vault.getAbstractFileByPath(conflict.path);
            if (file instanceof TFile) {
              const content = await this.app.vault.read(file);
              const contentHash = await apiBackend.gitBlobSha1(content);
              stateManager.setFileState(conflict.path, contentHash);
              await stateManager.save();
              this.log('Updated sync state after merge:', conflict.path);
            }
          } catch (error) {
            this.logger.error('Failed to update sync state:', error);
          }
        }

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
      // Keep refs so listeners can be removed when the setting changes
      this.fileChangeRefs = [
        this.app.vault.on('modify', (file) => {
          if (!this.gitignore.shouldIgnore(file.path)) {
            this.onFileChange();
          }
        }),
        this.app.vault.on('create', (file) => {
          if (!this.gitignore.shouldIgnore(file.path)) {
            this.onFileChange();
          }
        }),
        this.app.vault.on('delete', (file) => {
          if (!this.gitignore.shouldIgnore(file.path)) {
            this.onFileChange();
          }
        }),
        this.app.vault.on('rename', (file) => {
          if (!this.gitignore.shouldIgnore(file.path)) {
            this.onFileChange();
          }
        }),
      ];
    }
  }

  private stopAutoSync(): void {
    if (this.autoSyncInterval !== null) {
      window.clearInterval(this.autoSyncInterval);
      this.autoSyncInterval = null;
    }
    // Remove file-change listeners registered by a previous setup
    for (const ref of this.fileChangeRefs) {
      this.app.vault.offref(ref);
    }
    this.fileChangeRefs = [];
  }

  private onFileChange(): void {
    if (!this.network.isOnline()) return;
    if (this.pauseFileChangeSync) {
      this.log('File change sync paused');
      return;
    }
    this.syncQueue.enqueue(() => this.performSync());
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

    this.addCommand({
      id: 'untrack-ignored-files',
      name: 'Untrack ignored files',
      callback: () => void this.untrackIgnoredFiles(),
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

  async clearSyncState(): Promise<void> {
    if (this.backend instanceof ApiBackend) {
      const stateManager = (this.backend as ApiBackend).getStateManager();
      stateManager.clear();
      await stateManager.save();
      this.showNotice(t('notice.syncStateCleared'));
    }
  }

  // ===== Untrack Ignored Files =====

  private async untrackIgnoredFiles(): Promise<void> {
    if (!(this.backend instanceof GitBackend)) {
      this.showNotice(t('notice.untrackGitOnly'));
      return;
    }

    try {
      // Get list of tracked files
      const gitBackend = this.backend as GitBackend;
      const trackedFiles = await this.getTrackedFiles(gitBackend);

      // Filter out ignored files
      const ignoredTrackedFiles = trackedFiles.filter(file => this.gitignore.shouldIgnore(file));

      if (ignoredTrackedFiles.length === 0) {
        this.showNotice(t('notice.noIgnoredTrackedFiles'));
        return;
      }

      // Untrack the files
      for (const file of ignoredTrackedFiles) {
        await this.untrackFile(gitBackend, file);
      }

      this.showNotice(t('notice.untrackedFiles', { count: ignoredTrackedFiles.length }));
    } catch (error) {
      console.error('[HybridGitSync] Failed to untrack ignored files:', error);
      this.showNotice(t('notice.untrackFailed'));
    }
  }

  private async getTrackedFiles(gitBackend: GitBackend): Promise<string[]> {
    try {
      // Use git ls-files to get list of tracked files
      const output = await this.execGitCommand(gitBackend, 'ls-files');
      return output.split('\n').filter(file => file.trim() !== '');
    } catch (error) {
      console.error('[HybridGitSync] Failed to get tracked files:', error);
      return [];
    }
  }

  private async untrackFile(gitBackend: GitBackend, file: string): Promise<void> {
    try {
      // Use git rm --cached to untrack the file
      await this.execGitCommand(gitBackend, `rm --cached "${file}"`);
    } catch (error) {
      console.error(`[HybridGitSync] Failed to untrack file ${file}:`, error);
    }
  }

  private async execGitCommand(gitBackend: GitBackend, command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      gitBackend.exec(command).then(resolve).catch(reject);
    });
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

    if (isBinaryFile(activeFile.path)) {
      await this.app.vault.adapter.writeBinary(activeFile.path, remoteFile.content as ArrayBuffer);
    } else {
      await this.app.vault.adapter.write(activeFile.path, remoteFile.content as string);
    }
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

    // Binary files cannot be diffed
    if (isBinaryFile(path)) {
      this.showNotice('Diff view is not available for binary files');
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
    const remoteContent = remoteFile?.content as string || '';

    view.setDiff(path, remoteContent, localContent);
  }

  // ===== Helpers =====

  getActiveBackendName(): string {
    return this.backend?.name || 'not initialized';
  }

  getPlatformName(): string {
    return getPlatformName();
  }

  /**
   * Get file size in human readable format
   */
  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private showNotice(message: string, timeout?: number): void {
    new Notice(message, timeout);
  }

  private log(...args: unknown[]): void {
    if (this.settings.debug) {
      this.logger.info(...args);
    }
  }
}
