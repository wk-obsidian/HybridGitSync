import { requestUrl, RequestUrlResponse, Vault } from 'obsidian';
import { SyncBackend, SyncResult, SyncStatus, FileChange } from './base';
import { SyncStateManager } from '../sync/state';
import { GitignoreRules } from '../utils/gitignore';
import { t } from '../i18n';

export type ApiProvider = 'github' | 'gitlab' | 'gitea';

interface ApiConfig {
  provider: ApiProvider;
  token: string;
  repo: string;       // "owner/repo"
  branch: string;     // default branch
  baseUrl?: string;   // custom API endpoint for self-hosted
}

interface FileEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: 'file' | 'dir';
}

export class ApiBackend extends SyncBackend {
  readonly name: string;
  private config: ApiConfig;
  private baseUrl: string;
  private vault: Vault;
  private stateManager: SyncStateManager;
  private gitignore: GitignoreRules;
  private debug: boolean;

  constructor(vault: Vault, config: ApiConfig, gitignore?: GitignoreRules, debug: boolean = false) {
    super();
    this.vault = vault;
    this.config = config;
    this.name = `api-${config.provider}`;
    this.baseUrl = config.baseUrl || this.getDefaultBaseUrl(config.provider);
    this.stateManager = new SyncStateManager(vault);
    this.gitignore = gitignore || new GitignoreRules();
    this.debug = debug;
    this.log('ApiBackend created', {
      hasVault: !!vault,
      hasAdapter: !!vault?.adapter,
      repo: config.repo,
      branch: config.branch,
    });
  }

  private log(...args: any[]): void {
    if (this.debug) {
      console.log('[HybridGitSync]', ...args);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const repoInfo = await this.apiRequest('GET', `/repos/${this.config.repo}`);
      // Auto-detect default branch if not specified or invalid
      if (repoInfo.default_branch && this.config.branch !== repoInfo.default_branch) {
        console.log(`[HybridGitSync] Auto-correcting branch: ${this.config.branch} → ${repoInfo.default_branch}`);
        this.config.branch = repoInfo.default_branch;
      }
      return true;
    } catch {
      return false;
    }
  }

  async pull(): Promise<SyncResult> {
    try {
      const remoteFiles = await this.listFilesRecursive('');
      let pulled = 0;

      for (const file of remoteFiles) {
        const remote = await this.getFile(file.path);
        if (!remote) continue;

        // Check if local file exists and differs
        let needUpdate = false;
        try {
          const localContent = await this.vault.adapter.read(file.path);
          if (localContent !== remote.content) {
            needUpdate = true;
          }
        } catch {
          // File doesn't exist locally
          needUpdate = true;
        }

        if (needUpdate) {
          // Ensure parent directory exists
          const dir = file.path.substring(0, file.path.lastIndexOf('/'));
          if (dir) {
            try { await this.vault.adapter.mkdir(dir); } catch {}
          }
          await this.vault.adapter.write(file.path, remote.content);
          pulled++;
        }
      }

      return {
        success: true,
        message: `Pulled ${pulled} file(s) from remote`,
        pulled,
      };
    } catch (error) {
      return {
        success: false,
        message: `Pull failed: ${(error as Error).message}`,
        error: error as Error,
      };
    }
  }

  async push(): Promise<SyncResult> {
    try {
      // Get remote file list with SHAs
      const remoteFiles = await this.listFilesRecursive('');
      const remoteMap = new Map<string, string>(); // path -> sha
      for (const f of remoteFiles) {
        remoteMap.set(f.path, f.sha);
      }

      // Get local file list
      const localFiles = await this.listLocalFiles('');
      this.log('Local files:', localFiles);
      this.log('Remote files:', remoteMap.size);
      let pushed = 0;
      const errors: string[] = [];

      // Upload new/modified files
      for (const localPath of localFiles) {
        if (this.shouldIgnore(localPath)) continue;

        try {
          const localContent = await this.vault.adapter.read(localPath);
          const remoteSha = remoteMap.get(localPath);

          // Check if file needs update by comparing content
          if (remoteSha) {
            const remoteFile = await this.getFile(localPath);
            if (remoteFile && remoteFile.content === localContent) {
              remoteMap.delete(localPath); // Mark as processed
              continue; // No change
            }
          }

          this.log('Uploading:', localPath);
          await this.putFile(localPath, localContent, remoteSha);
          pushed++;
          remoteMap.delete(localPath); // Mark as processed
        } catch (e) {
          const errMsg = `${localPath}: ${(e as Error).message}`;
          console.error('[HybridGitSync] Error:', errMsg);
          errors.push(errMsg);
        }
      }

      // Delete remote files that don't exist locally
      for (const [path, sha] of remoteMap) {
        if (this.shouldIgnore(path)) continue;
        try {
          await this.deleteFile(path, sha);
          pushed++;
        } catch (e) {
          errors.push(`delete ${path}: ${(e as Error).message}`);
        }
      }

      if (errors.length > 0) {
        return {
          success: pushed > 0,
          message: `Pushed ${pushed} file(s), ${errors.length} error(s)`,
          pushed,
          error: new Error(errors.join('\n')),
        };
      }

      return {
        success: true,
        message: `Pushed ${pushed} file(s) to remote`,
        pushed,
      };
    } catch (error) {
      return {
        success: false,
        message: `Push failed: ${(error as Error).message}`,
        error: error as Error,
      };
    }
  }

  async sync(): Promise<SyncResult> {
    try {
      let pulled = 0;
      let pushed = 0;
      let deleted = 0;
      const errors: string[] = [];

      // Step 1: Load sync state
      await this.stateManager.load();
      this.log('Last sync:', this.stateManager.getLastSyncTime());

      // Step 2: Get current remote file tree (single API call)
      let remoteMap: Map<string, string>;
      try {
        remoteMap = await this.getRemoteTree();
        this.log('Remote files:', remoteMap.size);
      } catch (error) {
        // Network error - cannot reach remote
        console.warn('[HybridGitSync] Cannot reach remote, skipping sync:', (error as Error).message);
        return {
          success: false,
          message: 'Cannot reach remote. Check network connection.',
          error: error as Error,
        };
      }

      // Safety check: if remoteMap is empty but we have cached SHAs, something is wrong
      const cachedRemoteShas = this.stateManager.getAllRemoteShas();
      this.log('Cached remote SHAs:', cachedRemoteShas.size);
      if (remoteMap.size === 0 && cachedRemoteShas.size > 0) {
        console.warn('[HybridGitSync] Remote returned empty file list, skipping sync to prevent data loss');
        return {
          success: false,
          message: 'Remote returned empty file list. Skipping sync to prevent data loss.',
        };
      }

      // Step 4: Determine which remote files actually changed
      const changedRemoteFiles = new Set<string>();
      const newRemoteFiles = new Set<string>();
      const deletedRemoteFiles = new Set<string>();

      // Find new and modified remote files
      for (const [path, sha] of remoteMap) {
        if (this.shouldIgnore(path)) continue;
        const cachedSha = cachedRemoteShas.get(path);
        if (!cachedSha) {
          newRemoteFiles.add(path);
        } else if (cachedSha !== sha) {
          changedRemoteFiles.add(path);
        }
      }

      // Find deleted remote files
      for (const [path] of cachedRemoteShas) {
        if (!remoteMap.has(path) && !this.shouldIgnore(path)) {
          deletedRemoteFiles.add(path);
        }
      }

      this.log('Remote changes:', {
        new: newRemoteFiles.size,
        modified: changedRemoteFiles.size,
        deleted: deletedRemoteFiles.size,
      });

      // Step 5: Get current local file list with content hash
      const localFiles = await this.listLocalFiles('');
      const localMap = new Map<string, string>(); // path -> content hash
      for (const path of localFiles) {
        try {
          const content = await this.vault.adapter.read(path);
          localMap.set(path, await this.gitBlobSha1(content));
        } catch {}
      }
      this.log('Local files:', localMap.size);

      // Step 6: Detect local changes
      this.log('Detecting changes...');
      this.log('Local map:', Array.from(localMap.entries()).slice(0, 5));
      this.log('Remote map:', Array.from(remoteMap.entries()).slice(0, 5));
      this.log('Cached remote SHAs:', Array.from(cachedRemoteShas.entries()).slice(0, 5));
      this.log('Stored files:', Array.from(this.stateManager.getKnownFiles().entries()).slice(0, 5));

      const actions = this.stateManager.detectChanges(localMap, remoteMap);

      this.log('Detected actions:', {
        push: actions.pushToRemote.length,
        pull: actions.pullFromRemote.length,
        deleteRemote: actions.deleteFromRemote.length,
        deleteLocal: actions.deleteFromLocal.length,
        conflicts: actions.conflicts.length,
        needsComparison: actions.needsContentComparison.length,
      });

      // Step 7: Merge remote changes into actions
      // New remote files that don't exist locally → pull
      for (const path of newRemoteFiles) {
        if (!localMap.has(path)) {
          if (!actions.pullFromRemote.includes(path)) {
            actions.pullFromRemote.push(path);
          }
        } else {
          // Exists on both sides - need content comparison
          if (!actions.needsContentComparison.includes(path)) {
            actions.needsContentComparison.push(path);
          }
        }
      }

      // Modified remote files → pull (or conflict if also modified locally)
      for (const path of changedRemoteFiles) {
        const localChanged = localMap.has(path) &&
          this.stateManager.getFileState(path) !== localMap.get(path);
        if (localChanged) {
          if (!actions.conflicts.includes(path)) {
            actions.conflicts.push(path);
          }
        } else {
          if (!actions.pullFromRemote.includes(path)) {
            actions.pullFromRemote.push(path);
          }
        }
      }

      // Deleted remote files → delete locally
      for (const path of deletedRemoteFiles) {
        if (localMap.has(path)) {
          const localChanged = this.stateManager.getFileState(path) !== localMap.get(path);
          if (localChanged) {
            if (!actions.conflicts.includes(path)) {
              actions.conflicts.push(path);
            }
          } else {
            if (!actions.deleteFromLocal.includes(path)) {
              actions.deleteFromLocal.push(path);
            }
          }
        }
      }

      // Step 8: Handle files that need content comparison (new on both sides)
      const isFirstSync = cachedRemoteShas.size === 0;
      for (const path of actions.needsContentComparison) {
        if (this.shouldIgnore(path)) continue;
        try {
          const localContent = await this.vault.adapter.read(path);
          const remoteFile = await this.getFile(path);
          if (!remoteFile) continue;

          if (localContent === remoteFile.content) {
            // Same content - no action needed, just update state
            const contentHash = await this.gitBlobSha1(localContent);
            this.stateManager.setFileState(path, contentHash);
            this.log('Same content on both sides:', path);
          } else {
            // Different content - check who changed
            const storedHash = this.stateManager.getFileState(path);
            if (storedHash) {
              const localHash = await this.gitBlobSha1(localContent);
              const remoteHash = await this.gitBlobSha1(remoteFile.content);

              if (storedHash === localHash) {
                // Local unchanged, remote changed → pull
                this.log('Remote changed, pulling:', path);
                actions.pullFromRemote.push(path);
              } else if (storedHash === remoteHash) {
                // Remote unchanged, local changed → push
                this.log('Local changed, pushing:', path);
                actions.pushToRemote.push(path);
              } else {
                // Both changed → conflict
                this.log('Both changed, conflict:', path);
                actions.conflicts.push(path);
              }
            } else if (isFirstSync) {
              // First sync with no baseline - use remote as source of truth
              this.log('First sync, using remote version:', path);
              actions.pullFromRemote.push(path);
            } else {
              // No stored hash, can't determine who changed → push local
              this.log('No baseline, pushing local:', path);
              actions.pushToRemote.push(path);
            }
          }
        } catch (e) {
          errors.push(`compare ${path}: ${(e as Error).message}`);
        }
      }

      this.log('Actions:', {
        push: actions.pushToRemote.length,
        pull: actions.pullFromRemote.length,
        deleteRemote: actions.deleteFromRemote.length,
        deleteLocal: actions.deleteFromLocal.length,
        conflicts: actions.conflicts.length,
      });

      // Step 9: Pull new/modified remote files (parallel, max 3)
      const pullPromises = actions.pullFromRemote
        .filter(path => !this.shouldIgnore(path))
        .map(async (path) => {
          try {
            const remoteFile = await this.getFile(path);
            if (!remoteFile) return;

            const dir = path.substring(0, path.lastIndexOf('/'));
            if (dir) {
              try { await this.vault.adapter.mkdir(dir); } catch {}
            }
            await this.vault.adapter.write(path, remoteFile.content);
            // Store content hash (SHA-1)
            const contentHash = await this.gitBlobSha1(remoteFile.content);
            this.stateManager.setFileState(path, contentHash);
            // Update cached remote SHA
            const remoteSha = remoteMap.get(path);
            if (remoteSha) {
              this.stateManager.setRemoteSha(path, remoteSha);
            }
            pulled++;
            this.log('Downloaded:', path);
          } catch (e) {
            const errMsg = `pull ${path}: ${(e as Error).message}`;
            errors.push(errMsg);
            console.error('[HybridGitSync]', errMsg);
          }
        });

      // Execute in parallel with concurrency limit
      await this.parallelLimit(pullPromises, 3);

      // Step 10: Push new/modified local files (parallel, max 3)
      const pushPromises = actions.pushToRemote
        .filter(path => !this.shouldIgnore(path))
        .map(async (path) => {
          try {
            const content = await this.vault.adapter.read(path);

            // Check file size before uploading
            if (this.isFileTooLarge(content)) {
              const size = new TextEncoder().encode(content).length;
              console.warn(`[HybridGitSync] Skipping large file: ${path} (${this.formatFileSize(size)})`);
              return;
            }

            const sha = remoteMap.get(path);
            const newSha = await this.putFile(path, content, sha);
            // Store content hash (SHA-1)
            const contentHash = await this.gitBlobSha1(content);
            this.stateManager.setFileState(path, contentHash);
            // Update cached remote SHA
            this.stateManager.setRemoteSha(path, newSha);
            pushed++;
            this.log('Uploaded:', path);
          } catch (e) {
            const errMsg = `push ${path}: ${(e as Error).message}`;
            errors.push(errMsg);
            console.error('[HybridGitSync]', errMsg);
          }
        });

      // Execute in parallel with concurrency limit
      await this.parallelLimit(pushPromises, 3);

      // Step 11: Delete files that were deleted locally
      for (const path of actions.deleteFromRemote) {
        if (this.shouldIgnore(path)) continue;
        try {
          const sha = remoteMap.get(path);
          if (sha) {
            await this.deleteFile(path, sha);
            this.stateManager.removeFileState(path);
            deleted++;
            this.log('Deleted from remote:', path);
          }
        } catch (e) {
          errors.push(`delete remote ${path}: ${(e as Error).message}`);
        }
      }

      // Step 12: Delete files that were deleted remotely
      for (const path of actions.deleteFromLocal) {
        if (this.shouldIgnore(path)) continue;
        try {
          await this.vault.adapter.remove(path);
          this.stateManager.removeFileState(path);
          deleted++;
          this.log('Deleted locally:', path);
        } catch (e) {
          errors.push(`delete local ${path}: ${(e as Error).message}`);
        }
      }

      // Step 13: Cache remote SHAs for next sync
      const remoteShas: Record<string, string> = {};
      for (const [path, sha] of remoteMap) {
        remoteShas[path] = sha;
      }
      this.stateManager.setAllRemoteShas(remoteShas);

      // Step 14: Save sync state
      await this.stateManager.save();

      // Build message using i18n
      let message: string;
      const params = { pulled, pushed, deleted };
      if (actions.conflicts.length > 0) {
        message = t('sync.completed.withConflicts', { ...params, conflicts: actions.conflicts.length });
      } else if (errors.length > 0) {
        message = t('sync.completed.withErrors', { ...params, errors: errors.length });
      } else {
        message = t('sync.completed', params);
      }

      return {
        success: errors.length === 0 && actions.conflicts.length === 0,
        message,
        pulled,
        pushed,
        conflicts: actions.conflicts,
        error: errors.length > 0 ? new Error(errors.join('\n')) : undefined,
      };
    } catch (error) {
      return {
        success: false,
        message: t('sync.failed', { message: (error as Error).message }),
        error: error as Error,
      };
    }
  }

  async status(): Promise<SyncStatus> {
    try {
      const remoteFiles = await this.listFilesRecursive('');
      const remoteMap = new Map<string, string>();
      for (const f of remoteFiles) {
        remoteMap.set(f.path, f.sha);
      }

      const localFiles = await this.listLocalFiles('');
      const changedFiles: FileChange[] = [];

      for (const localPath of localFiles) {
        if (this.shouldIgnore(localPath)) continue;

        const remoteSha = remoteMap.get(localPath);
        if (!remoteSha) {
          changedFiles.push({ path: localPath, status: 'added' });
        } else {
          const localContent = await this.vault.adapter.read(localPath);
          const remoteFile = await this.getFile(localPath);
          if (remoteFile && remoteFile.content !== localContent) {
            changedFiles.push({ path: localPath, status: 'modified' });
          }
          remoteMap.delete(localPath);
        }
      }

      // Remaining remote files are deletions
      for (const path of remoteMap.keys()) {
        if (!this.shouldIgnore(path)) {
          changedFiles.push({ path, status: 'deleted' });
        }
      }

      return {
        ahead: changedFiles.length,
        behind: 0,
        changedFiles,
        branch: this.config.branch,
        hasConflicts: false,
      };
    } catch {
      return {
        ahead: 0,
        behind: 0,
        changedFiles: [],
        branch: this.config.branch,
        hasConflicts: false,
      };
    }
  }

  dispose(): void {
    // Nothing to dispose
  }

  /**
   * Get the sync state manager (for conflict resolution)
   */
  getStateManager(): SyncStateManager {
    return this.stateManager;
  }

  /** Get the current branch (may be auto-corrected) */
  getBranch(): string {
    return this.config.branch;
  }

  // ===== File operations =====

  async getFile(path: string): Promise<{ content: string; sha: string } | null> {
    try {
      const data = await this.apiRequest('GET',
        `/repos/${this.config.repo}/contents/${path}?ref=${this.config.branch}`
      );
      if (data.type !== 'file') return null;

      let content: string;
      if (data.encoding === 'base64') {
        try {
          content = decodeURIComponent(escape(atob(data.content)));
        } catch (e) {
          console.warn('[HybridGitSync] URI decode failed for:', path, '- trying fallback');
          // Fallback: try direct atob without URI decoding
          try {
            content = atob(data.content);
          } catch {
            // If still fails, use raw content
            console.warn('[HybridGitSync] atob also failed for:', path, '- using raw content');
            content = data.content;
          }
        }
      } else {
        content = data.content;
      }

      return { content, sha: data.sha };
    } catch (error: any) {
      if (error.message?.includes('404')) return null;
      throw error;
    }
  }

  async putFile(path: string, content: string, sha?: string): Promise<string> {
    const body: any = {
      message: `sync: ${path}`,
      content: btoa(unescape(encodeURIComponent(content))),
      branch: this.config.branch,
    };
    if (sha) body.sha = sha;

    const data = await this.apiRequest('PUT',
      `/repos/${this.config.repo}/contents/${path}`, body
    );
    return data.content.sha;
  }

  async deleteFile(path: string, sha: string): Promise<void> {
    await this.apiRequest('DELETE',
      `/repos/${this.config.repo}/contents/${path}`, {
        message: `delete: ${path}`,
        sha,
        branch: this.config.branch,
      }
    );
  }

  async listFiles(path: string = ''): Promise<FileEntry[]> {
    try {
      const data = await this.apiRequest('GET',
        `/repos/${this.config.repo}/contents/${path}?ref=${this.config.branch}`
      );
      if (!Array.isArray(data)) return [];
      return data.map((item: any) => ({
        name: item.name,
        path: item.path,
        sha: item.sha,
        size: item.size,
        type: item.type as 'file' | 'dir',
      }));
    } catch {
      return [];
    }
  }

  async listFilesRecursive(path: string = ''): Promise<FileEntry[]> {
    const entries = await this.listFiles(path);
    const results: FileEntry[] = [];

    for (const entry of entries) {
      if (entry.type === 'file') {
        results.push(entry);
      } else if (entry.type === 'dir') {
        const subEntries = await this.listFilesRecursive(entry.path);
        results.push(...subEntries);
      }
    }
    return results;
  }

  /**
   * Get remote file tree with SHAs using Git Tree API (single API call)
   * This is much more efficient than fetching each file individually
   */
  async getRemoteTree(): Promise<Map<string, string>> {
    const fileMap = new Map<string, string>(); // path -> sha

    // Get the tree SHA for the branch
    const branchInfo = await this.apiRequest('GET',
      `/repos/${this.config.repo}/git/refs/heads/${this.config.branch}`
    );
    const treeSha = branchInfo.object.sha;

    // Get the entire tree recursively
    const tree = await this.apiRequest('GET',
      `/repos/${this.config.repo}/git/trees/${treeSha}?recursive=1`
    );

    if (tree.tree) {
      for (const item of tree.tree) {
        if (item.type === 'blob') { // Only files, not directories
          fileMap.set(item.path, item.sha);
        }
      }
    }

    return fileMap;
  }

  // ===== History Methods =====

  /**
   * Get commit history
   */
  async getCommitHistory(limit: number = 50): Promise<any[]> {
    try {
      const data = await this.apiRequest('GET',
        `/repos/${this.config.repo}/commits?sha=${this.config.branch}&per_page=${limit}`
      );
      return data.map((commit: any) => ({
        sha: commit.sha,
        message: commit.commit.message.split('\n')[0], // First line only
        author: commit.commit.author.name,
        date: commit.commit.author.date,
        files: [], // Would need additional API call to get files
      }));
    } catch (error) {
      console.error('[HybridGitSync] Failed to get commit history:', error);
      return [];
    }
  }

  /**
   * Get commit details with changed files
   */
  async getCommitDetails(sha: string): Promise<any> {
    try {
      const data = await this.apiRequest('GET',
        `/repos/${this.config.repo}/commits/${sha}`
      );
      return {
        sha: data.sha,
        message: data.commit.message,
        author: data.commit.author.name,
        date: data.commit.author.date,
        files: data.files?.map((f: any) => ({
          path: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
        })) || [],
      };
    } catch (error) {
      console.error('[HybridGitSync] Failed to get commit details:', error);
      return null;
    }
  }

  /**
   * Get file history
   */
  async getFileHistory(path: string, limit: number = 20): Promise<any[]> {
    try {
      const data = await this.apiRequest('GET',
        `/repos/${this.config.repo}/commits?sha=${this.config.branch}&path=${path}&per_page=${limit}`
      );
      return data.map((commit: any) => ({
        sha: commit.sha,
        message: commit.commit.message.split('\n')[0],
        author: commit.commit.author.name,
        date: commit.commit.author.date,
      }));
    } catch (error) {
      console.error('[HybridGitSync] Failed to get file history:', error);
      return [];
    }
  }

  /**
   * Get file content at specific commit
   */
  async getFileAtCommit(path: string, sha: string): Promise<string | null> {
    try {
      const data = await this.apiRequest('GET',
        `/repos/${this.config.repo}/contents/${path}?ref=${sha}`
      );
      if (data.encoding === 'base64') {
        try {
          return decodeURIComponent(escape(atob(data.content)));
        } catch {
          return atob(data.content);
        }
      }
      return data.content;
    } catch (error) {
      console.error('[HybridGitSync] Failed to get file at commit:', error);
      return null;
    }
  }

  /**
   * Get branches list
   */
  async getBranches(): Promise<string[]> {
    try {
      const data = await this.apiRequest('GET',
        `/repos/${this.config.repo}/branches`
      );
      return data.map((branch: any) => branch.name);
    } catch (error) {
      console.error('[HybridGitSync] Failed to get branches:', error);
      return [];
    }
  }

  // ===== Private helpers =====

  /**
   * Execute promises in parallel with concurrency limit
   */
  private async parallelLimit(promises: Promise<void>[], limit: number): Promise<void> {
    const results: Promise<void>[] = [];
    const executing: Set<Promise<void>> = new Set();

    for (const promise of promises) {
      const p = promise.then(() => {
        executing.delete(p);
      });
      executing.add(p);
      results.push(p);

      if (executing.size >= limit) {
        await Promise.race(executing);
      }
    }

    await Promise.all(results);
  }

  /**
   * Check if file is too large for API
   * GitHub API limit is around 50MB for content API
   */
  private isFileTooLarge(content: string): boolean {
    const sizeInBytes = new TextEncoder().encode(content).length;
    const maxSize = 50 * 1024 * 1024; // 50MB (GitHub API actual limit)
    return sizeInBytes > maxSize;
  }

  /**
   * Get file size in human readable format
   */
  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Generate Git-compatible blob SHA-1
   * Git computes SHA as: SHA1("blob " + content.length + "\0" + content)
   */
  async gitBlobSha1(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const contentBytes = encoder.encode(content);
    const header = encoder.encode(`blob ${contentBytes.length}\0`);

    // Combine header and content
    const combined = new Uint8Array(header.length + contentBytes.length);
    combined.set(header);
    combined.set(contentBytes, header.length);

    const hashBuffer = await crypto.subtle.digest('SHA-1', combined);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private async listLocalFiles(path: string): Promise<string[]> {
    const results: string[] = [];
    const listing = await this.vault.adapter.list(path);
    this.log('Scanning:', path || '/', '→', listing.files.length, 'files,', listing.folders.length, 'folders');
    this.log('Files:', listing.files);
    this.log('Folders:', listing.folders);

    for (const file of listing.files) {
      if (!this.shouldIgnore(file)) {
        results.push(file);
      }
    }

    for (const dir of listing.folders) {
      if (!this.shouldIgnore(dir)) {
        const subFiles = await this.listLocalFiles(dir);
        results.push(...subFiles);
      }
    }

    return results;
  }

  private shouldIgnore(path: string): boolean {
    return this.gitignore.shouldIgnore(path);
  }

  private getDefaultBaseUrl(provider: ApiProvider): string {
    switch (provider) {
      case 'github': return 'https://api.github.com';
      case 'gitlab': return 'https://gitlab.com/api/v4';
      case 'gitea': return 'https://gitea.com/api/v1';
    }
  }

  private async apiRequest(
    method: string,
    path: string,
    body?: any
  ): Promise<any> {
    // Split path and query string
    const [pathPart, queryPart] = path.split('?');

    // URL-encode only the path segments to handle special characters (Chinese, spaces, etc.)
    const encodedPath = pathPart.split('/').map(segment => encodeURIComponent(segment)).join('/');

    // Reconstruct URL with query string (if any)
    const url = queryPart
      ? `${this.baseUrl}${encodedPath}?${queryPart}`
      : `${this.baseUrl}${encodedPath}`;

    const headers: Record<string, string> = {
      'Authorization': `token ${this.config.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    if (this.config.provider === 'gitlab') {
      headers['Authorization'] = `Bearer ${this.config.token}`;
    }

    const response: RequestUrlResponse = await requestUrl({
      url,
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      throw: false,
    });

    if (response.status >= 400) {
      throw new Error(`API error ${response.status}: ${response.text}`);
    }

    return response.json;
  }
}
