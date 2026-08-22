import { requestUrl, RequestUrlResponse, Vault } from 'obsidian';
import { SyncBackend, SyncResult, SyncStatus, FileChange } from './base';
import { SyncStateManager } from '../sync/state';
import { GitignoreRules } from '../utils/gitignore';
import { Logger, LogLevel } from '../utils/logger';
import { t } from '../i18n';
import { getErrorMessage, toError } from '../utils/error';
import { isBinaryFile } from '../utils/binary';
import { TempFileManager } from '../utils/temp-file';

export type ApiProvider = 'github' | 'gitlab' | 'gitea';

interface ApiConfig {
  provider: ApiProvider;
  token: string;
  repo: string;       // "owner/repo"
  branch: string;     // default branch
  baseUrl?: string;   // custom API endpoint for self-hosted
  commitMessage?: string; // commit message template with {{date}} and {{path}}
}

interface FileEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: 'file' | 'dir';
}

interface RepoInfo {
  default_branch: string;
}

interface GitTreeItem {
  path: string;
  sha: string;
  type: 'blob' | 'tree';
}

interface GitTreeResponse {
  tree: GitTreeItem[];
}

interface GitRef {
  object: { sha: string };
}

interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
  files?: string[];
}

interface CommitDetail {
  sha: string;
  message: string;
  author: string;
  date: string;
  files: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
}

interface FileContent {
  type: string;
  encoding: string;
  content: string;
  sha: string;
}

interface PutFileResponse {
  content: { sha: string };
}

export class ApiBackend extends SyncBackend {
  readonly name: string;
  private config: ApiConfig;
  private baseUrl: string;
  private vault: Vault;
  private stateManager: SyncStateManager;
  private gitignore: GitignoreRules;
  private debug: boolean;
  private logger: Logger;
  private tempFileManager: TempFileManager;

  constructor(vault: Vault, config: ApiConfig, gitignore?: GitignoreRules, debug: boolean = false) {
    super();
    this.vault = vault;
    this.config = config;
    this.name = `api-${config.provider}`;
    this.baseUrl = config.baseUrl || this.getDefaultBaseUrl(config.provider);
    this.stateManager = new SyncStateManager(vault);
    this.gitignore = gitignore || new GitignoreRules();
    this.debug = debug;
    this.logger = new Logger('ApiBackend', debug ? LogLevel.DEBUG : LogLevel.INFO);
    this.tempFileManager = new TempFileManager(vault, debug);
    this.log('ApiBackend created', {
      hasVault: !!vault,
      hasAdapter: !!vault?.adapter,
      repo: config.repo,
      branch: config.branch,
    });
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      this.logger.info(...args);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const repoInfo = await this.apiRequest('GET', `/repos/${this.config.repo}`) as RepoInfo;
      // Auto-detect default branch if not specified or invalid
      if (repoInfo.default_branch && this.config.branch !== repoInfo.default_branch) {
        this.log(`Auto-correcting branch: ${this.config.branch} → ${repoInfo.default_branch}`);
        this.config.branch = repoInfo.default_branch;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if the remote repository is empty (no commits, no branches)
   */
  async isEmptyRepo(): Promise<boolean> {
    try {
      await this.apiRequest('GET',
        `/repos/${this.config.repo}/git/refs/heads/${this.config.branch}`
      );
      return false; // Branch exists, repo is not empty
    } catch (error) {
      // 404 or 409 means empty repo (GitHub returns 409 "Git Repository is empty")
      const msg = (error as Error).message || '';
      if (msg.includes('404') || msg.includes('409')) {
        this.log('Repository is empty (no branch refs found)');
        return true;
      }
      // Other errors (network, auth) -> rethrow
      throw error;
    }
  }

  /**
   * Initialize an empty repository by creating the first commit with .gitignore
   */
  async initializeRepo(): Promise<SyncResult> {
    try {
      console.log('[HybridGitSync] Initializing empty repository...');

      // Get .gitignore content
      const gitignoreContent = this.gitignore.getDefaultContent();
      const base64Content = btoa(unescape(encodeURIComponent(gitignoreContent)));

      if (this.config.provider === 'gitlab') {
        // GitLab: use Commits API (creates branch automatically)
        await this.initializeGitlabRepo(gitignoreContent);
      } else {
        // GitHub/Gitea: use Git Data API chain
        await this.initializeGithubGiteaRepo(base64Content);
      }

      console.log('[HybridGitSync] Repository initialized successfully');
      return {
        success: true,
        message: t('repo.initialized'),
      };
    } catch (error) {
      const errorMsg = (error as Error).message || String(error);
      console.error('[HybridGitSync] Failed to initialize repository:', errorMsg);
      console.error('[HybridGitSync] Full error:', error);
      return {
        success: false,
        message: t('repo.initFailed', { message: errorMsg }),
        error: error as Error,
      };
    }
  }

  /**
   * GitHub/Gitea: Use Contents API to create first file (auto-creates branch)
   */
  private async initializeGithubGiteaRepo(base64Content: string): Promise<void> {
    // Use Contents API to create .gitignore - this auto-creates the default branch
    console.log('[HybridGitSync] Creating .gitignore via Contents API...');
    try {
      // Don't specify branch - let GitHub/Gitea create the default branch automatically
      const data = await this.apiRequest('PUT',
        `/repos/${this.config.repo}/contents/.gitignore`,
        {
          message: 'Initial commit',
          content: base64Content,
        }
      ) as { content: { sha: string } };
      console.log('[HybridGitSync] Created .gitignore, sha:', data.content.sha);

      // Now detect the actual default branch
      const repoInfo = await this.apiRequest('GET', `/repos/${this.config.repo}`) as RepoInfo;
      if (repoInfo.default_branch) {
        this.config.branch = repoInfo.default_branch;
        console.log('[HybridGitSync] Detected default branch:', this.config.branch);
      }
    } catch (error) {
      console.error('[HybridGitSync] Error in initializeGithubGiteaRepo:', error);
      throw error;
    }
  }

  /**
   * GitLab: Commits API with actions array
   */
  private async initializeGitlabRepo(content: string): Promise<void> {
    // GitLab uses project path encoded: owner/repo -> owner%2Frepo
    const projectId = encodeURIComponent(this.config.repo);

    await this.apiRequest('POST',
      `/projects/${projectId}/repository/commits`,
      {
        branch: this.config.branch,
        commit_message: 'Initial commit',
        actions: [{
          action: 'create',
          file_path: '.gitignore',
          content: content,
        }],
      }
    );
    this.log('GitLab: Created initial commit with .gitignore');
  }

  // ===== Git Data API Methods =====

  /**
   * Create a blob for a file content
   */
  private async createBlob(content: string | ArrayBuffer, isBinary: boolean): Promise<string> {
    const base64Content = isBinary
      ? this.encodeBase64Binary(content)
      : this.encodeBase64Text(content);

    const data = await this.apiRequest('POST',
      `/repos/${this.config.repo}/git/blobs`,
      { content: base64Content, encoding: 'base64' }
    ) as { sha: string };

    return data.sha;
  }

  /**
   * Create a tree with multiple files
   */
  private async createTree(
    items: Array<{ path: string; sha: string; mode?: string }>,
    baseTree?: string
  ): Promise<string> {
    const treeItems = items.map(item => ({
      path: item.path,
      mode: item.mode || '100644',
      type: 'blob' as const,
      sha: item.sha,
    }));

    const body: Record<string, unknown> = {
      tree: treeItems,
    };
    if (baseTree) {
      body.base_tree = baseTree;
    }

    const data = await this.apiRequest('POST',
      `/repos/${this.config.repo}/git/trees`,
      body
    ) as { sha: string };

    return data.sha;
  }

  /**
   * Create a commit with the given tree
   */
  private async createCommit(
    message: string,
    treeSha: string,
    parentSha?: string
  ): Promise<string> {
    const body: Record<string, unknown> = {
      message,
      tree: treeSha,
    };
    if (parentSha) {
      body.parents = [parentSha];
    }

    const data = await this.apiRequest('POST',
      `/repos/${this.config.repo}/git/commits`,
      body
    ) as { sha: string };

    return data.sha;
  }

  /**
   * Update branch reference to new commit
   */
  private async updateRef(branch: string, sha: string, isCreate: boolean = false): Promise<void> {
    if (isCreate) {
      await this.apiRequest('POST',
        `/repos/${this.config.repo}/git/refs`,
        { ref: `refs/heads/${branch}`, sha }
      );
    } else {
      await this.apiRequest('PATCH',
        `/repos/${this.config.repo}/git/refs/heads/${branch}`,
        { sha }
      );
    }
  }

  /**
   * Build commit message from template
   */
  private buildCommitMessage(): string {
    const now = new Date();
    const dateStr = now.toISOString().replace('T', ' ').substring(0, 19);
    return (this.config.commitMessage || 'vault backup: {{date}}')
      .replace('{{date}}', dateStr)
      .replace('{{path}}', 'batch');
  }

  /**
   * Execute promises with concurrency limit
   * Stops on first rejection and propagates the error
   */
  private async parallelLimit<T>(
    promises: Promise<T>[],
    limit: number
  ): Promise<T[]> {
    const results: T[] = [];
    const executing = new Set<Promise<void>>();

    for (const promise of promises) {
      const p = promise.then(result => {
        results.push(result);
        executing.delete(p);
      }).catch(err => {
        executing.delete(p);
        throw err;
      });
      executing.add(p);

      if (executing.size >= limit) {
        await Promise.race(executing);
      }
    }

    if (executing.size > 0) {
      await Promise.all(executing);
    }
    return results;
  }

  async pull(): Promise<SyncResult> {
    try {
      // Clean up orphaned temp files first
      await this.tempFileManager.cleanup();
      await this.tempFileManager.init();

      const remoteFiles = await this.listFilesRecursive('');
      let pulled = 0;

      for (const file of remoteFiles) {
        const remote = await this.getFile(file.path);
        if (!remote) continue;

        const isBinary = isBinaryFile(file.path);

        // Check if local file exists and differs
        let needUpdate = false;
        try {
          if (isBinary) {
            const localContent = await this.vault.adapter.readBinary(file.path);
            needUpdate = localContent.byteLength !== (remote.content as ArrayBuffer).byteLength;
          } else {
            const localContent = await this.vault.adapter.read(file.path);
            if (localContent !== remote.content) {
              needUpdate = true;
            }
          }
        } catch {
          // File doesn't exist locally
          needUpdate = true;
        }

        if (needUpdate) {
          // Use safe write for atomic file operations
          await this.tempFileManager.writeSafe(file.path, remote.content);
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
        message: `Pull failed: ${getErrorMessage(error)}`,
        error: toError(error),
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
          const isBinary = isBinaryFile(localPath);
          const remoteSha = remoteMap.get(localPath);

          let localContent: string | ArrayBuffer;
          if (isBinary) {
            localContent = await this.vault.adapter.readBinary(localPath);
          } else {
            localContent = await this.vault.adapter.read(localPath);
          }

          // Check if file needs update by comparing content
          if (remoteSha) {
            const remoteFile = await this.getFile(localPath);
            if (remoteFile) {
              // For binary files, compare by size; for text, compare content
              const isSame = isBinary
                ? (remoteFile.content as ArrayBuffer).byteLength === (localContent as ArrayBuffer).byteLength
                : remoteFile.content === localContent;
              if (isSame) {
                remoteMap.delete(localPath); // Mark as processed
                continue; // No change
              }
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
        message: `Push failed: ${getErrorMessage(error)}`,
        error: toError(error),
      };
    }
  }

  async sync(): Promise<SyncResult> {
    try {
      let pulled = 0;
      let pushed = 0;
      let deleted = 0;
      const errors: string[] = [];
      const skippedFiles: Array<{ path: string; size: number; reason: string }> = [];

      // Step 0: Clean up orphaned temp files and initialize temp directory
      await this.tempFileManager.cleanup();
      await this.tempFileManager.init();

      // Step 1: Load sync state
      await this.stateManager.load();
      this.log('Last sync:', this.stateManager.getLastSyncTime());

      // Step 2: Get current remote file tree (single API call)
      let remoteMap: Map<string, string>;
      try {
        remoteMap = await this.getRemoteTree();
        this.log('Remote files:', remoteMap.size);
      } catch (error) {
        // Network error or API error
        const errorMsg = getErrorMessage(error);
        this.logger.warn('Cannot reach remote, skipping sync:', errorMsg);
        return {
          success: false,
          message: `Cannot reach remote: ${errorMsg}`,
          error: toError(error),
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
          if (isBinaryFile(path)) {
            const content = await this.vault.adapter.readBinary(path);
            localMap.set(path, await this.gitBlobSha1Binary(content));
          } else {
            const content = await this.vault.adapter.read(path);
            localMap.set(path, await this.gitBlobSha1(content));
          }
        } catch { /* skip files that can't be read */ }
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
          const isBinary = isBinaryFile(path);
          const remoteFile = await this.getFile(path);
          if (!remoteFile) continue;

          let localContent: string | ArrayBuffer;
          let localHash: string;
          let remoteHash: string;

          if (isBinary) {
            localContent = await this.vault.adapter.readBinary(path);
            localHash = await this.gitBlobSha1Binary(localContent);
            remoteHash = await this.gitBlobSha1Binary(remoteFile.content as ArrayBuffer);
          } else {
            localContent = await this.vault.adapter.read(path);
            localHash = await this.gitBlobSha1(localContent);
            remoteHash = await this.gitBlobSha1(remoteFile.content as string);
          }

          // Compare by hash (works for both text and binary)
          if (localHash === remoteHash) {
            // Same content - no action needed, just update state
            this.stateManager.setFileState(path, localHash);
            this.log('Same content on both sides:', path);
          } else {
            // Different content - check who changed
            const storedHash = this.stateManager.getFileState(path);
            if (storedHash) {
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

      // Step 9: Pull new/modified remote files
      // Separate large files from small files for better handling
      const smallFiles: string[] = [];
      const largeFiles: string[] = [];
      const LARGE_FILE_THRESHOLD = 1024 * 1024; // 1MB

      for (const path of actions.pullFromRemote) {
        if (this.shouldIgnore(path)) continue;
        const remoteSha = remoteMap.get(path);
        // We'll determine size during download, so check all files
        smallFiles.push(path);
      }

      this.log('Files to pull:', smallFiles.length);

      // Download small files in parallel (max 3)
      const pullPromises = smallFiles
        .map(async (path) => {
          try {
            const remoteFile = await this.getFile(path);
            if (!remoteFile) return;

            const isBinary = isBinaryFile(path);
            const contentSize = isBinary
              ? (remoteFile.content as ArrayBuffer).byteLength
              : (remoteFile.content as string).length;

            this.log(`Processing ${path}: ${contentSize} bytes, binary: ${isBinary}`);

            // Use safe write for atomic file operations
            await this.tempFileManager.writeSafe(path, remoteFile.content);

            // Store content hash (SHA-1)
            const contentHash = isBinary
              ? await this.gitBlobSha1Binary(remoteFile.content as ArrayBuffer)
              : await this.gitBlobSha1(remoteFile.content as string);
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

      // Step 10: Push changes using Git Data API with batch processing
      const filesToPush = actions.pushToRemote.filter(path => !this.shouldIgnore(path));
      const filesToDelete = actions.deleteFromRemote.filter(path => !this.shouldIgnore(path));

      if (filesToPush.length > 0 || filesToDelete.length > 0) {
        try {
          // Get current commit SHA
          const refData = await this.apiRequest('GET',
            `/repos/${this.config.repo}/git/refs/heads/${this.config.branch}`
          );
          const branchInfo = (Array.isArray(refData) ? refData[0] : refData) as GitRef;
          let currentCommitSha = branchInfo?.object?.sha;

          // Step 10a: Calculate file sizes and check for large files
          const BATCH_SIZE_THRESHOLD = 100 * 1024 * 1024; // 100MB
          const filesWithSize: Array<{ path: string; size: number }> = [];

          for (const path of filesToPush) {
            try {
              const isBinary = isBinaryFile(path);
              let size: number;

              if (isBinary) {
                const content = await this.vault.adapter.readBinary(path);
                size = (content as ArrayBuffer).byteLength;
              } else {
                const content = await this.vault.adapter.read(path);
                size = new TextEncoder().encode(content).length;
              }

              if (size > 100 * 1024 * 1024) {
                skippedFiles.push({ path, size, reason: t('file.skippedLargeReason') });
              } else {
                filesWithSize.push({ path, size });
              }
            } catch (e) {
              errors.push(`size check ${path}: ${(e as Error).message}`);
            }
          }

          // Step 10b: Split into batches based on total size
          const batches: Array<Array<{ path: string; size: number }>> = [];
          let currentBatch: Array<{ path: string; size: number }> = [];
          let currentBatchSize = 0;

          for (const file of filesWithSize) {
            if (currentBatchSize + file.size > BATCH_SIZE_THRESHOLD && currentBatch.length > 0) {
              batches.push(currentBatch);
              currentBatch = [];
              currentBatchSize = 0;
            }
            currentBatch.push(file);
            currentBatchSize += file.size;
          }
          if (currentBatch.length > 0) {
            batches.push(currentBatch);
          }

          this.log(`Split ${filesWithSize.length} files into ${batches.length} batches`);
          this.log(`Provider: ${this.config.provider}`);

          // Step 10c & 10d: Push files and handle deletions - route by provider
          if (this.config.provider === 'gitlab') {
            // GitLab: Use Commits API (supports batch with actions array)
            this.log('Using GitLab Commits API (batch)');

            for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
              const batch = batches[batchIndex];
              this.log(`Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} files)`);

              // Read file contents
              const filesWithContent: { path: string; content: string; contentHash: string }[] = [];
              for (const file of batch) {
                try {
                  const isBinary = isBinaryFile(file.path);
                  let content: string | ArrayBuffer;

                  if (isBinary) {
                    content = await this.vault.adapter.readBinary(file.path);
                  } else {
                    content = await this.vault.adapter.read(file.path);
                  }

                  const contentHash = isBinary
                    ? await this.gitBlobSha1Binary(content as ArrayBuffer)
                    : await this.gitBlobSha1(content as string);

                  const textContent = isBinary
                    ? this.encodeBase64Binary(content as ArrayBuffer)
                    : content as string;

                  filesWithContent.push({ path: file.path, content: textContent, contentHash });
                } catch (e) {
                  errors.push(`read ${file.path}: ${(e as Error).message}`);
                }
              }

              if (filesWithContent.length === 0 && filesToDelete.length === 0) continue;

              const commitMessage = this.buildCommitMessage();

              // For the last batch, include deletions
              const isLastBatch = batchIndex === batches.length - 1;
              const deletionsForBatch = isLastBatch ? filesToDelete : [];

              const result = await this.batchCommitWithCommitsApi(
                filesWithContent.map(f => ({ path: f.path, content: f.content })),
                commitMessage,
                deletionsForBatch
              );

              if (result.success) {
                for (const file of filesWithContent) {
                  this.stateManager.setFileState(file.path, file.contentHash);
                  pushed++;
                }
                if (isLastBatch) {
                  for (const path of filesToDelete) {
                    this.stateManager.removeFileState(path);
                    deleted++;
                  }
                }
                this.log(`Batch ${batchIndex + 1} complete (Commits API): ${filesWithContent.length} pushed, ${deletionsForBatch.length} deleted`);
              } else {
                errors.push(`batch ${batchIndex + 1}: ${result.error}`);
              }
            }
          } else if (this.config.provider === 'github') {
            // GitHub: Use Git Data API (batch commit)
            this.log('Using Git Data API (batch)');

            for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
              const batch = batches[batchIndex];
              this.log(`Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} files)`);

              // Read file contents
              const filesWithContent: { path: string; content: string; contentHash: string }[] = [];
              for (const file of batch) {
                try {
                  const isBinary = isBinaryFile(file.path);
                  let content: string | ArrayBuffer;

                  if (isBinary) {
                    content = await this.vault.adapter.readBinary(file.path);
                  } else {
                    content = await this.vault.adapter.read(file.path);
                  }

                  const contentHash = isBinary
                    ? await this.gitBlobSha1Binary(content as ArrayBuffer)
                    : await this.gitBlobSha1(content as string);

                  const textContent = isBinary
                    ? this.encodeBase64Binary(content as ArrayBuffer)
                    : content as string;

                  filesWithContent.push({ path: file.path, content: textContent, contentHash });
                } catch (e) {
                  errors.push(`read ${file.path}: ${(e as Error).message}`);
                }
              }

              if (filesWithContent.length === 0) continue;

              const commitMessage = this.buildCommitMessage();

              const result = await this.batchCommitWithGitDataApi(
                filesWithContent.map(f => ({ path: f.path, content: f.content })),
                commitMessage
              );

              if (result.success) {
                for (const file of filesWithContent) {
                  this.stateManager.setFileState(file.path, file.contentHash);
                  pushed++;
                }
                this.log(`Batch ${batchIndex + 1} complete (Git Data API): ${filesWithContent.length} files pushed`);
              } else {
                errors.push(`batch ${batchIndex + 1}: ${result.error}`);
              }
            }

            // GitHub: Handle deletions separately with Git Data API
            if (filesToDelete.length > 0) {
              this.log(`Processing ${filesToDelete.length} file deletions`);
              try {
                const currentTree = await this.apiRequest('GET',
                  `/repos/${this.config.repo}/git/trees/${currentCommitSha}`
                ) as GitTreeResponse;

                const deleteSet = new Set(filesToDelete);
                const treeItems = [];

                if (currentTree.tree) {
                  for (const item of currentTree.tree) {
                    if (item.type === 'blob' && !deleteSet.has(item.path)) {
                      treeItems.push({ path: item.path, sha: item.sha });
                    }
                  }
                }

                const treeSha = await this.createTree(treeItems, currentCommitSha);
                const commitMessage = this.buildCommitMessage();
                const commitSha = await this.createCommit(commitMessage, treeSha, currentCommitSha);
                await this.updateRef(this.config.branch, commitSha);

                for (const path of filesToDelete) {
                  this.stateManager.removeFileState(path);
                  deleted++;
                }

                this.log(`Deletion complete (Git Data API): ${deleted} files deleted`);
              } catch (e) {
                errors.push(`delete commit: ${(e as Error).message}`);
              }
            }
          } else {
            // Gitea: Use Contents API (one file at a time)
            this.log('Using Contents API (sequential)');

            for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
              const batch = batches[batchIndex];
              this.log(`Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} files)`);

              // Read file contents
              const filesWithContent: { path: string; content: string; contentHash: string }[] = [];
              for (const file of batch) {
                try {
                  const isBinary = isBinaryFile(file.path);
                  let content: string | ArrayBuffer;

                  if (isBinary) {
                    content = await this.vault.adapter.readBinary(file.path);
                  } else {
                    content = await this.vault.adapter.read(file.path);
                  }

                  const contentHash = isBinary
                    ? await this.gitBlobSha1Binary(content as ArrayBuffer)
                    : await this.gitBlobSha1(content as string);

                  const textContent = isBinary
                    ? this.encodeBase64Binary(content as ArrayBuffer)
                    : content as string;

                  filesWithContent.push({ path: file.path, content: textContent, contentHash });
                } catch (e) {
                  errors.push(`read ${file.path}: ${(e as Error).message}`);
                }
              }

              if (filesWithContent.length === 0) continue;

              const commitMessage = this.buildCommitMessage();

              const result = await this.uploadFilesWithContentsApi(
                filesWithContent.map(f => ({ path: f.path, content: f.content })),
                commitMessage
              );

              if (result.success) {
                for (const file of filesWithContent) {
                  this.stateManager.setFileState(file.path, file.contentHash);
                  pushed++;
                }
                this.log(`Batch ${batchIndex + 1} complete (Contents API): ${filesWithContent.length} files pushed`);
              } else {
                errors.push(`batch ${batchIndex + 1}: ${result.error}`);
              }
            }

            // Gitea: Handle deletions with Contents API
            if (filesToDelete.length > 0) {
              this.log(`Processing ${filesToDelete.length} file deletions`);
              for (const path of filesToDelete) {
                try {
                  const fileData = await this.apiRequest<{ sha: string }>(
                    'GET',
                    `/repos/${this.config.repo}/contents/${path}`
                  );
                  await this.deleteFile(path, fileData.sha);
                  this.stateManager.removeFileState(path);
                  deleted++;
                } catch (e) {
                  errors.push(`delete ${path}: ${(e as Error).message}`);
                }
              }
              this.log(`Deletion complete (Contents API): ${deleted} files deleted`);
            }
          }

          this.log(`Push complete: ${pushed} files pushed, ${deleted} files deleted`);
        } catch (e) {
          const errMsg = `batch push: ${(e as Error).message}`;
          errors.push(errMsg);
          console.error('[HybridGitSync]', errMsg);
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
        skipped: skippedFiles.length > 0 ? skippedFiles : undefined,
        conflicts: actions.conflicts,
        error: errors.length > 0 ? new Error(errors.join('\n')) : undefined,
      };
    } catch (error) {
      return {
        success: false,
        message: t('sync.failed', { message: getErrorMessage(error) }),
        error: toError(error),
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
          const isBinary = isBinaryFile(localPath);
          const remoteFile = await this.getFile(localPath);
          if (remoteFile) {
            let isSame: boolean;
            if (isBinary) {
              const localContent = await this.vault.adapter.readBinary(localPath);
              isSame = (remoteFile.content as ArrayBuffer).byteLength === localContent.byteLength;
            } else {
              const localContent = await this.vault.adapter.read(localPath);
              isSame = remoteFile.content === localContent;
            }
            if (!isSame) {
              changedFiles.push({ path: localPath, status: 'modified' });
            }
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

  /**
   * Decode base64 to ArrayBuffer (for binary files)
   */
  private decodeBase64Binary(base64: string): ArrayBuffer {
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * Decode base64 to UTF-8 string (for text files)
   */
  private decodeBase64Text(base64: string): string {
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  /**
   * Encode ArrayBuffer to base64 (for binary files)
   */
  private encodeBase64Binary(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binaryStr = '';
    for (let i = 0; i < bytes.length; i++) {
      binaryStr += String.fromCharCode(bytes[i]);
    }
    return btoa(binaryStr);
  }

  /**
   * Encode UTF-8 string to base64 (for text files)
   */
  private encodeBase64Text(str: string): string {
    const bytes = new TextEncoder().encode(str);
    let binaryStr = '';
    for (let i = 0; i < bytes.length; i++) {
      binaryStr += String.fromCharCode(bytes[i]);
    }
    return btoa(binaryStr);
  }

  async getFile(path: string): Promise<{ content: string | ArrayBuffer; sha: string } | null> {
    try {
      const data = await this.apiRequest('GET',
        `/repos/${this.config.repo}/contents/${path}?ref=${this.config.branch}`
      ) as FileContent & { download_url?: string; size?: number };
      if (data.type !== 'file') return null;

      const isBinary = isBinaryFile(path);
      let content: string | ArrayBuffer;

      // For large files (>1MB), content may be empty - use download_url with proper encoding
      if (!data.content && data.download_url) {
        this.log('Large file detected, using download_url:', path);
        this.log('File size:', data.size, 'bytes');
        const startTime = Date.now();
        try {
          // Encode the download_url properly to handle Chinese characters
          const downloadUrl = encodeURI(data.download_url);
          this.log('Encoded download URL:', downloadUrl);

          this.log('Starting download...');

          // Create a wrapper to track download progress
          const downloadPromise = (async () => {
            try {
              const result = await requestUrl({
                url: downloadUrl,
                method: 'GET',
                throw: false,
              });
              return result;
            } catch (err) {
              this.log('requestUrl threw error:', err);
              throw err;
            }
          })();

          // 2 minute timeout for large files (Obsidian may have shorter internal timeout)
          const timeoutMs = 2 * 60 * 1000;
          const timeoutPromise = new Promise<never>((_, reject) => {
            const timer = setTimeout(() => {
              this.log(`Download timeout after ${timeoutMs}ms for: ${path}`);
              reject(new Error(`Download timeout after ${timeoutMs / 1000} seconds`));
            }, timeoutMs);
            // Prevent timer from keeping process alive
            if (timer.unref) timer.unref();
          });

          const response = await Promise.race([downloadPromise, timeoutPromise]);
          const elapsed = Date.now() - startTime;
          this.log(`Download completed in ${elapsed}ms`);

          this.log('Download response status:', response.status);
          if (response.status >= 400) {
            this.log('Download response text:', response.text?.substring(0, 500));
            throw new Error(`Download failed with status ${response.status}`);
          }
          const responseSize = response.arrayBuffer?.byteLength || response.text?.length || 0;
          this.log('Download response size:', responseSize, 'bytes');
          if (responseSize === 0) {
            throw new Error('Download response is empty');
          }
          if (isBinary) {
            content = response.arrayBuffer;
          } else {
            content = response.text;
          }
        } catch (downloadError) {
          const elapsed = Date.now() - startTime;
          console.error(`[HybridGitSync] Download failed for ${path} after ${elapsed}ms:`, downloadError);
          throw new Error(`Failed to download large file: ${getErrorMessage(downloadError)}`);
        }
      } else if (data.encoding === 'base64') {
        try {
          if (isBinary) {
            content = this.decodeBase64Binary(data.content);
          } else {
            content = this.decodeBase64Text(data.content);
          }
        } catch {
          console.warn('[HybridGitSync] Base64 decode failed for:', path, '- using raw content');
          content = data.content;
        }
      } else {
        content = data.content;
      }

      return { content, sha: data.sha };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('404')) return null;
      throw error;
    }
  }

  /**
   * Upload files using Git Data API (batch commit)
   * Creates blobs, builds tree, commits, and updates ref in one atomic operation.
   * Falls back to Contents API if Git Data API is not supported (e.g. Gitea).
   *
   * @returns { success, error? } - error indicates fallback should be tried
   */
  private async batchCommitWithGitDataApi(
    files: { path: string; content: string }[],
    commitMessage: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.log('batchCommitWithGitDataApi: starting with', files.length, 'files');

      // Step 1: Get current tree hash (null for empty repo)
      let baseTreeSha: string | null = null;
      let parentSha: string | undefined;
      try {
        const refData = await this.apiRequest<{ object: { sha: string } }>(
          'GET', `/repos/${this.config.repo}/git/refs/heads/${this.config.branch}`
        );
        parentSha = refData.object.sha;
        const commitData = await this.apiRequest<{ tree: { sha: string } }>(
          'GET', `/repos/${this.config.repo}/git/commits/${parentSha}`
        );
        baseTreeSha = commitData.tree.sha;
        this.log('batchCommitWithGitDataApi: got base tree', baseTreeSha);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('404') || msg.includes('409')) {
          baseTreeSha = null;
          parentSha = undefined;
          this.log('batchCommitWithGitDataApi: empty repo (no base tree)');
        } else {
          this.log('batchCommitWithGitDataApi: error getting base tree:', msg);
          throw e;
        }
      }

      // Step 2: Create blobs for all files in parallel
      this.log('batchCommitWithGitDataApi: creating blobs...');
      const blobPromises = files.map(async (file) => {
        const blobSha = await this.createBlob(file.content, false);
        return { path: file.path, sha: blobSha };
      });
      const blobResults = await this.parallelLimit(blobPromises, 5);
      this.log('batchCommitWithGitDataApi: created', blobResults.length, 'blobs');

      // Step 3: Build tree entries
      const treeEntries: TreeEntry[] = blobResults.map((blob) => ({
        path: blob.path,
        mode: '100644' as const,
        type: 'blob' as const,
        sha: blob.sha,
      }));

      // Step 4: Create tree (with base tree if available)
      this.log('batchCommitWithGitDataApi: creating tree...');
      const tree = await this.createTree(treeEntries, baseTreeSha || undefined);
      this.log('batchCommitWithGitDataApi: created tree', tree);

      // Step 5: Create commit
      this.log('batchCommitWithGitDataApi: creating commit...');
      const commit = await this.createCommit(commitMessage, tree, parentSha);
      this.log('batchCommitWithGitDataApi: created commit', commit);

      // Step 6: Update ref (create or update)
      const branch = this.config.branch;
      const isCreate = !parentSha;
      await this.updateRef(branch, commit, isCreate);
      this.log('batchCommitWithGitDataApi: updated ref');

      return { success: true };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error ? e.stack : '';
      this.log('batchCommitWithGitDataApi: failed with error:', msg);
      if (stack) {
        this.log('batchCommitWithGitDataApi: stack:', stack.substring(0, 500));
      }
      return { success: false, error: msg };
    }
  }

  /**
   * Upload files using Contents API (one file at a time)
   * Fallback when Git Data API is not supported.
   */
  private async uploadFilesWithContentsApi(
    files: { path: string; content: string }[],
    commitMessage: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      for (const file of files) {
        let existingSha: string | undefined;
        try {
          const existing = await this.apiRequest<{ sha: string }>(
            'GET',
            `/repos/${this.config.repo}/contents/${file.path}`
          );
          existingSha = existing.sha;
        } catch {
          existingSha = undefined;
        }

        const body: Record<string, unknown> = {
          message: commitMessage,
          content: this.encodeBase64Text(file.content),
          branch: this.config.branch,
        };
        if (existingSha) {
          body.sha = existingSha;
        }

        await this.apiRequest('PUT', `/repos/${this.config.repo}/contents/${file.path}`, body);
      }
      return { success: true };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  /**
   * Upload/delete files using GitLab Commits API (batch with actions array)
   * Supports create, update, and delete in a single commit.
   */
  private async batchCommitWithCommitsApi(
    files: { path: string; content: string }[],
    commitMessage: string,
    filesToDelete: string[] = []
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const projectId = encodeURIComponent(this.config.repo);
      const actions: Array<Record<string, unknown>> = [];

      // Add create/update actions
      for (const file of files) {
        // Check if file exists to determine action type
        const encodedFilePath = encodeURIComponent(file.path);
        let action = 'create';
        try {
          await this.apiRequest('GET',
            `/projects/${projectId}/repository/files/${encodedFilePath}?ref=${this.config.branch}`
          );
          action = 'update';
        } catch {
          action = 'create';
        }

        actions.push({
          action,
          file_path: file.path,
          content: file.content,
          encoding: 'text',
        });
      }

      // Add delete actions
      for (const path of filesToDelete) {
        actions.push({
          action: 'delete',
          file_path: path,
        });
      }

      if (actions.length === 0) {
        return { success: true };
      }

      await this.apiRequest('POST',
        `/projects/${projectId}/repository/commits`,
        {
          branch: this.config.branch,
          commit_message: commitMessage,
          actions,
        }
      );

      return { success: true };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  async putFile(path: string, content: string | ArrayBuffer, sha?: string): Promise<string> {
    const isBinary = content instanceof ArrayBuffer;
    const base64Content = isBinary
      ? this.encodeBase64Binary(content)
      : this.encodeBase64Text(content);

    // Build commit message from template
    const now = new Date();
    const dateStr = now.toISOString().replace('T', ' ').substring(0, 19);
    const commitMessage = (this.config.commitMessage || 'sync: {{path}}')
      .replace('{{date}}', dateStr)
      .replace('{{path}}', path);

    const body: Record<string, string> = {
      message: commitMessage,
      content: base64Content,
      branch: this.config.branch,
    };
    if (sha) body.sha = sha;

    // Retry logic for 409 Conflict errors (concurrent writes)
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const data = await this.apiRequest('PUT',
          `/repos/${this.config.repo}/contents/${path}`, body
        ) as PutFileResponse;
        return data.content.sha;
      } catch (error) {
        const msg = (error as Error).message || '';
        if (msg.includes('409') && attempt < maxRetries - 1) {
          // Wait before retry (exponential backoff: 1s, 2s, 4s)
          const delay = Math.pow(2, attempt) * 1000;
          this.log(`Conflict uploading ${path}, retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
    throw new Error(`Failed to upload ${path} after ${maxRetries} attempts`);
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
      ) as Array<Record<string, unknown>>;
      if (!Array.isArray(data)) return [];
      return data.map((item) => ({
        name: item.name as string,
        path: item.path as string,
        sha: item.sha as string,
        size: item.size as number,
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
    const fileMap = new Map<string, string>();

    try {
      // Gitea returns an array, GitHub returns a single object
      const refData = await this.apiRequest('GET',
        `/repos/${this.config.repo}/git/refs/heads/${this.config.branch}`
      );
      const branchInfo = (Array.isArray(refData) ? refData[0] : refData) as GitRef;

      if (!branchInfo?.object?.sha) {
        throw new Error(`Branch not found: ${this.config.branch}`);
      }
      const treeSha = branchInfo.object.sha;

      // Gitea uses ?recursive=true, GitHub uses ?recursive=1
      const recursiveParam = this.config.provider === 'gitea' ? 'recursive=true' : 'recursive=1';
      const tree = await this.apiRequest('GET',
        `/repos/${this.config.repo}/git/trees/${treeSha}?${recursiveParam}`
      ) as GitTreeResponse;

      if (tree.tree) {
        for (const item of tree.tree) {
          if (item.type === 'blob') {
            fileMap.set(item.path, item.sha);
          }
        }
      }
    } catch (error) {
      // 404 or 409 means empty repo (no branch refs) - return empty map
      // GitHub returns 409 "Git Repository is empty" for empty repos
      const msg = (error as Error).message || '';
      if (msg.includes('404') || msg.includes('409')) {
        this.log('Remote tree: empty repository (no branch refs)');
        return fileMap;
      }
      throw error;
    }

    return fileMap;
  }

  // ===== History Methods =====

  /**
   * Get commit history
   */
  async getCommitHistory(limit: number = 50): Promise<CommitInfo[]> {
    try {
      // Gitea uses 'limit', GitHub uses 'per_page'
      const limitParam = this.config.provider === 'gitea' ? 'limit' : 'per_page';
      const data = await this.apiRequest('GET',
        `/repos/${this.config.repo}/commits?sha=${this.config.branch}&${limitParam}=${limit}`
      ) as Array<Record<string, unknown>>;
      return data.map((commit) => {
        const commitData = commit.commit as Record<string, unknown>;
        const author = commitData.author as Record<string, string>;
        return {
          sha: commit.sha as string,
          message: (commitData.message as string).split('\n')[0],
          author: author.name,
          date: author.date,
          files: [],
        };
      });
    } catch (error) {
      console.error('[HybridGitSync] Failed to get commit history:', error);
      return [];
    }
  }

  /**
   * Get commit details with changed files
   */
  async getCommitDetails(sha: string): Promise<CommitDetail | null> {
    try {
      const data = await this.apiRequest('GET',
        `/repos/${this.config.repo}/commits/${sha}`
      ) as Record<string, unknown>;
      const commitData = data.commit as Record<string, unknown>;
      const author = commitData.author as Record<string, string>;
      const files = (data.files as Array<Record<string, unknown>>) || [];
      return {
        sha: data.sha as string,
        message: commitData.message as string,
        author: author.name,
        date: author.date,
        files: files.map((f) => ({
          path: f.filename as string,
          status: f.status as string,
          additions: f.additions as number,
          deletions: f.deletions as number,
        })),
      };
    } catch (error) {
      console.error('[HybridGitSync] Failed to get commit details:', error);
      return null;
    }
  }

  /**
   * Get file history
   */
  async getFileHistory(path: string, limit: number = 20): Promise<CommitInfo[]> {
    try {
      // Gitea uses 'limit', GitHub uses 'per_page'
      const limitParam = this.config.provider === 'gitea' ? 'limit' : 'per_page';
      const data = await this.apiRequest('GET',
        `/repos/${this.config.repo}/commits?sha=${this.config.branch}&path=${path}&${limitParam}=${limit}`
      ) as Array<Record<string, unknown>>;
      return data.map((commit) => {
        const commitData = commit.commit as Record<string, unknown>;
        const author = commitData.author as Record<string, string>;
        return {
          sha: commit.sha as string,
          message: (commitData.message as string).split('\n')[0],
          author: author.name,
          date: author.date,
          files: [],
        };
      });
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
      ) as FileContent;
      if (data.encoding === 'base64') {
        // For binary files, we still return string for history view
        // The history view is read-only and doesn't need perfect binary handling
        return this.decodeBase64Text(data.content);
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
      ) as Array<Record<string, string>>;
      return data.map((branch) => branch.name);
    } catch (error) {
      console.error('[HybridGitSync] Failed to get branches:', error);
      return [];
    }
  }

  // ===== Private helpers =====

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
   * Generate Git-compatible blob SHA-1 for text content
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

  /**
   * Generate Git-compatible blob SHA-1 for binary content (ArrayBuffer)
   * Git computes SHA as: SHA1("blob " + content.length + "\0" + content)
   */
  async gitBlobSha1Binary(content: ArrayBuffer): Promise<string> {
    const encoder = new TextEncoder();
    const contentBytes = new Uint8Array(content);
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
    body?: Record<string, unknown>
  ): Promise<unknown> {
    const [pathPart, queryPart] = path.split('?');
    const encodedPath = pathPart.split('/').map(segment => encodeURIComponent(segment)).join('/');
    const url = queryPart
      ? `${this.baseUrl}${encodedPath}?${queryPart}`
      : `${this.baseUrl}${encodedPath}`;

    console.log('[HybridGitSync] apiRequest:', method, url);

    const headers: Record<string, string> = {
      'Authorization': `token ${this.config.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    if (this.config.provider === 'gitlab') {
      headers['Authorization'] = `Bearer ${this.config.token}`;
    }

    try {
      const response: RequestUrlResponse = await requestUrl({
        url,
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        throw: false,
      });

      console.log('[HybridGitSync] apiRequest response status:', response.status);

      if (response.status >= 400) {
        const errorText = response.text || '';
        console.error('[HybridGitSync] apiRequest error:', response.status, errorText);
        throw new Error(`API error ${response.status}: ${errorText}`);
      }

      return response.json;
    } catch (error) {
      console.error('[HybridGitSync] apiRequest exception:', error);
      throw error;
    }
  }
}
