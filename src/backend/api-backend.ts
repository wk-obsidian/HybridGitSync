import { requestUrl, RequestUrlResponse, Vault } from 'obsidian';
import { SyncBackend, SyncResult, SyncStatus, FileChange } from './base';
import { SyncStateManager } from '../sync/state';
import { GitignoreRules } from '../utils/gitignore';

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

  constructor(vault: Vault, config: ApiConfig, gitignore?: GitignoreRules) {
    super();
    this.vault = vault;
    this.config = config;
    this.name = `api-${config.provider}`;
    this.baseUrl = config.baseUrl || this.getDefaultBaseUrl(config.provider);
    this.stateManager = new SyncStateManager(vault);
    this.gitignore = gitignore || new GitignoreRules();
    console.log('[HybridGitSync] ApiBackend created', {
      hasVault: !!vault,
      hasAdapter: !!vault?.adapter,
      repo: config.repo,
      branch: config.branch,
    });
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
      console.log('[HybridGitSync] Local files:', localFiles);
      console.log('[HybridGitSync] Remote files:', remoteMap.size);
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

          console.log('[HybridGitSync] Uploading:', localPath);
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
      console.log('[HybridGitSync] Last sync:', this.stateManager.getLastSyncTime());

      // Step 2: Get current remote file list
      const remoteFiles = await this.listFilesRecursive('');
      const remoteMap = new Map<string, string>(); // path -> sha
      for (const f of remoteFiles) {
        remoteMap.set(f.path, f.sha);
      }
      console.log('[HybridGitSync] Remote files:', remoteMap.size);

      // Step 3: Get current local file list with content hash
      const localFiles = await this.listLocalFiles('');
      const localMap = new Map<string, string>(); // path -> content hash
      for (const path of localFiles) {
        try {
          const content = await this.vault.adapter.read(path);
          localMap.set(path, await this.sha1(content));
        } catch {}
      }
      console.log('[HybridGitSync] Local files:', localMap.size);

      // Step 4: Detect changes
      const actions = this.stateManager.detectChanges(localMap, remoteMap);

      // Step 4.5: Handle files that need content comparison (new on both sides)
      for (const path of actions.needsContentComparison) {
        if (this.shouldIgnore(path)) continue;
        try {
          const localContent = await this.vault.adapter.read(path);
          const remoteFile = await this.getFile(path);
          if (!remoteFile) continue;

          if (localContent === remoteFile.content) {
            // Same content - no action needed, just update state
            const contentHash = await this.sha1(localContent);
            this.stateManager.setFileState(path, contentHash);
            console.log('[HybridGitSync] Same content on both sides:', path);
          } else {
            // Different content - conflict
            actions.conflicts.push(path);
            console.log('[HybridGitSync] Conflict (different content):', path);
          }
        } catch (e) {
          errors.push(`compare ${path}: ${(e as Error).message}`);
        }
      }

      console.log('[HybridGitSync] Actions:', {
        push: actions.pushToRemote.length,
        pull: actions.pullFromRemote.length,
        deleteRemote: actions.deleteFromRemote.length,
        deleteLocal: actions.deleteFromLocal.length,
        conflicts: actions.conflicts.length,
      });

      // Step 5: Pull new/modified remote files
      for (const path of actions.pullFromRemote) {
        if (this.shouldIgnore(path)) continue;
        try {
          const remoteFile = await this.getFile(path);
          if (!remoteFile) continue;

          const dir = path.substring(0, path.lastIndexOf('/'));
          if (dir) {
            try { await this.vault.adapter.mkdir(dir); } catch {}
          }
          await this.vault.adapter.write(path, remoteFile.content);
          // Store content hash (SHA-1) instead of Git blob SHA
          const contentHash = await this.sha1(remoteFile.content);
          this.stateManager.setFileState(path, contentHash);
          pulled++;
          console.log('[HybridGitSync] Downloaded:', path);
        } catch (e) {
          errors.push(`pull ${path}: ${(e as Error).message}`);
        }
      }

      // Step 6: Push new/modified local files
      for (const path of actions.pushToRemote) {
        if (this.shouldIgnore(path)) continue;
        try {
          const content = await this.vault.adapter.read(path);
          const sha = remoteMap.get(path);
          await this.putFile(path, content, sha);
          // Store content hash (SHA-1) instead of Git blob SHA
          const contentHash = await this.sha1(content);
          this.stateManager.setFileState(path, contentHash);
          pushed++;
          console.log('[HybridGitSync] Uploaded:', path);
        } catch (e) {
          errors.push(`push ${path}: ${(e as Error).message}`);
        }
      }

      // Step 7: Delete files that were deleted locally
      for (const path of actions.deleteFromRemote) {
        if (this.shouldIgnore(path)) continue;
        try {
          const sha = remoteMap.get(path);
          if (sha) {
            await this.deleteFile(path, sha);
            this.stateManager.removeFileState(path);
            deleted++;
            console.log('[HybridGitSync] Deleted from remote:', path);
          }
        } catch (e) {
          errors.push(`delete remote ${path}: ${(e as Error).message}`);
        }
      }

      // Step 8: Delete files that were deleted remotely
      for (const path of actions.deleteFromLocal) {
        if (this.shouldIgnore(path)) continue;
        try {
          await this.vault.adapter.remove(path);
          this.stateManager.removeFileState(path);
          deleted++;
          console.log('[HybridGitSync] Deleted locally:', path);
        } catch (e) {
          errors.push(`delete local ${path}: ${(e as Error).message}`);
        }
      }

      // Step 9: Save sync state
      await this.stateManager.save();

      const message = `Sync completed: pulled ${pulled}, pushed ${pushed}, deleted ${deleted}` +
        (actions.conflicts.length > 0 ? `, ${actions.conflicts.length} conflict(s)` : '') +
        (errors.length > 0 ? `, ${errors.length} error(s)` : '');

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
        message: `Sync failed: ${(error as Error).message}`,
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

  // ===== Private helpers =====

  /**
   * Generate SHA-1 hash of content (for change detection)
   */
  private async sha1(content: string): Promise<string> {
    const msgBuffer = new TextEncoder().encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-1', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private async listLocalFiles(path: string): Promise<string[]> {
    const results: string[] = [];
    const listing = await this.vault.adapter.list(path);
    console.log('[HybridGitSync] Scanning:', path || '/', '→', listing.files.length, 'files,', listing.folders.length, 'folders');
    console.log('[HybridGitSync] Files:', listing.files);
    console.log('[HybridGitSync] Folders:', listing.folders);

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
    const url = `${this.baseUrl}${path}`;
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
