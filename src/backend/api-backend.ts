import { requestUrl, RequestUrlResponse, Vault } from 'obsidian';
import { SyncBackend, SyncResult, SyncStatus, FileChange } from './base';

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

  constructor(vault: Vault, config: ApiConfig) {
    super();
    this.vault = vault;
    this.config = config;
    this.name = `api-${config.provider}`;
    this.baseUrl = config.baseUrl || this.getDefaultBaseUrl(config.provider);
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
      const errors: string[] = [];

      // Step 1: Get remote file list
      const remoteFiles = await this.listFilesRecursive('');
      const remoteMap = new Map<string, string>(); // path -> sha
      for (const f of remoteFiles) {
        remoteMap.set(f.path, f.sha);
      }
      console.log('[HybridGitSync] Remote files:', remoteMap.size);

      // Step 2: Get local file list
      const localFiles = await this.listLocalFiles('');
      const localSet = new Set(localFiles);
      console.log('[HybridGitSync] Local files:', localFiles.length);

      // Step 3: Pull files that exist only remotely or are newer
      for (const [remotePath, remoteSha] of remoteMap) {
        if (this.shouldIgnore(remotePath)) continue;

        try {
          const remoteFile = await this.getFile(remotePath);
          if (!remoteFile) continue;

          let needDownload = false;
          try {
            const localContent = await this.vault.adapter.read(remotePath);
            if (localContent !== remoteFile.content) {
              // Both have different content - check which is newer
              // For now, we'll detect this as a conflict in the sync engine
              console.log('[HybridGitSync] Conflict detected:', remotePath);
              continue; // Skip for now, conflict resolution handles this
            }
          } catch {
            // File doesn't exist locally
            needDownload = true;
          }

          if (needDownload) {
            // Ensure parent directory exists
            const dir = remotePath.substring(0, remotePath.lastIndexOf('/'));
            if (dir) {
              try { await this.vault.adapter.mkdir(dir); } catch {}
            }
            await this.vault.adapter.write(remotePath, remoteFile.content);
            pulled++;
            console.log('[HybridGitSync] Downloaded:', remotePath);
          }
        } catch (e) {
          errors.push(`pull ${remotePath}: ${(e as Error).message}`);
        }
      }

      // Step 4: Push files that exist only locally or are newer
      for (const localPath of localFiles) {
        if (this.shouldIgnore(localPath)) continue;

        try {
          const localContent = await this.vault.adapter.read(localPath);
          const remoteSha = remoteMap.get(localPath);

          if (remoteSha) {
            // File exists on both sides - check if content differs
            const remoteFile = await this.getFile(localPath);
            if (remoteFile && remoteFile.content === localContent) {
              continue; // Same content, skip
            }
            // Content differs - this should be a conflict, but for now we push local
            console.log('[HybridGitSync] Content differs, pushing local:', localPath);
          }

          await this.putFile(localPath, localContent, remoteSha);
          pushed++;
          console.log('[HybridGitSync] Uploaded:', localPath);
        } catch (e) {
          errors.push(`push ${localPath}: ${(e as Error).message}`);
        }
      }

      const message = `Sync completed: pulled ${pulled}, pushed ${pushed}` +
        (errors.length > 0 ? `, ${errors.length} error(s)` : '');

      return {
        success: errors.length === 0,
        message,
        pulled,
        pushed,
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

      const content = data.encoding === 'base64'
        ? decodeURIComponent(escape(atob(data.content)))
        : data.content;

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
    const ignorePatterns = [
      '.obsidian/',
      '.trash/',
      '.git/',
      '.DS_Store',
      'Thumbs.db',
    ];
    return ignorePatterns.some(p => path.includes(p));
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
