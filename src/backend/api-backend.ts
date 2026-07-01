import { requestUrl, RequestUrlResponse } from 'obsidian';
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
  content?: string;
  encoding?: string;
}

export class ApiBackend extends SyncBackend {
  readonly name: string;
  private config: ApiConfig;
  private baseUrl: string;

  constructor(config: ApiConfig) {
    super();
    this.config = config;
    this.name = `api-${config.provider}`;
    this.baseUrl = config.baseUrl || this.getDefaultBaseUrl(config.provider);
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.apiRequest('GET', `/repos/${this.config.repo}`);
      return true;
    } catch {
      return false;
    }
  }

  async pull(): Promise<SyncResult> {
    // Pull is handled at file level by the sync engine
    // This method fetches the latest file tree from remote
    try {
      const files = await this.listFilesRecursive('');
      return {
        success: true,
        message: `Fetched ${files.length} files from remote`,
        pulled: files.length,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to fetch remote files',
        error: error as Error,
      };
    }
  }

  async push(): Promise<SyncResult> {
    // Push is handled at file level by the sync engine
    return {
      success: true,
      message: 'Push delegated to sync engine',
    };
  }

  async sync(): Promise<SyncResult> {
    // Full sync is delegated to the sync engine
    // which handles file-level diff and conflict resolution
    return {
      success: true,
      message: 'Sync delegated to sync engine',
    };
  }

  async status(): Promise<SyncStatus> {
    try {
      // Get latest commit on configured branch
      const commits = await this.apiRequest('GET',
        `/repos/${this.config.repo}/commits?sha=${this.config.branch}&per_page=1`
      );

      return {
        ahead: 0, // tracked locally by sync engine
        behind: 0,
        changedFiles: [],
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

  // ===== Public API methods for the sync engine =====

  /** Get a single file from remote */
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

  /** Create or update a file on remote */
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

  /** Delete a file on remote */
  async deleteFile(path: string, sha: string): Promise<void> {
    await this.apiRequest('DELETE',
      `/repos/${this.config.repo}/contents/${path}`, {
        message: `delete: ${path}`,
        sha,
        branch: this.config.branch,
      }
    );
  }

  /** List files in a directory */
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

  /** Recursively list all files */
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

  /** Get the latest commit SHA for the branch */
  async getLatestCommitSha(): Promise<string> {
    const data = await this.apiRequest('GET',
      `/repos/${this.config.repo}/commits?sha=${this.config.branch}&per_page=1`
    );
    return data[0]?.sha || '';
  }

  // ===== Private helpers =====

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

    // GitLab uses different auth header
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
