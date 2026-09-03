import { Vault } from 'obsidian';
import { Logger, LogLevel } from '../utils/logger';

const STATE_FILE_NAME = 'plugins/hybrid-git-sync/.sync-state.json';

export interface SyncState {
  lastSyncTime: string;
  files: Record<string, string>; // path -> content hash
  remoteShas: Record<string, string>; // path -> remote git blob SHA (cached)
  lastSyncHeadSha?: string; // HEAD SHA at last sync, for compare API rename detection
  repoId?: string; // backend identity (provider|baseUrl|repo|branch) the cache belongs to
}

/**
 * Manages sync state to track what was synced last time
 * This allows detecting local/remote deletions
 */
export class SyncStateManager {
  private vault: Vault;
  private state: SyncState;
  private debug: boolean;
  private stateFile: string;
  private logger: Logger;

  constructor(vault: Vault, debug: boolean = false) {
    this.stateFile = `${vault.configDir}/${STATE_FILE_NAME}`;
    this.vault = vault;
    this.state = { lastSyncTime: '', files: {}, remoteShas: {} };
    this.debug = debug;
    this.logger = new Logger('SyncState', debug ? LogLevel.DEBUG : LogLevel.INFO);
  }

  /**
   * Get the repo identity this cache was synced against (may be undefined for
   * state files written before repo identity tracking was added)
   */
  getRepoId(): string | undefined {
    return this.state.repoId;
  }

  /**
   * Set the repo identity the cache belongs to (provider|baseUrl|repo|branch)
   */
  setRepoId(repoId: string): void {
    this.state.repoId = repoId;
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      this.logger.info(...args);
    }
  }

  /**
   * Load sync state from disk
   */
  async load(): Promise<void> {
    try {
      const content = await this.vault.adapter.read(this.stateFile);
      const parsed = JSON.parse(content) as Partial<SyncState>;
      this.state = {
        lastSyncTime: typeof parsed.lastSyncTime === 'string' ? parsed.lastSyncTime : '',
        files: parsed.files ?? {},
        remoteShas: parsed.remoteShas ?? {},
        ...(typeof parsed.lastSyncHeadSha === 'string' ? { lastSyncHeadSha: parsed.lastSyncHeadSha } : {}),
        ...(typeof parsed.repoId === 'string' ? { repoId: parsed.repoId } : {}),
      };
    } catch {
      // No state file yet or corrupted - start fresh
      this.state = { lastSyncTime: '', files: {}, remoteShas: {} };
    }
  }

  /**
   * Save sync state to disk
   */
  async save(): Promise<void> {
    this.state.lastSyncTime = new Date().toISOString();
    const content = JSON.stringify(this.state, null, 2);
    try {
      await this.vault.adapter.write(this.stateFile, content);
    } catch (error) {
      console.error('[SyncState] Failed to save state:', error);
    }
  }

  /**
   * Get the last known state of a file
   */
  getFileState(path: string): string | undefined {
    return this.state.files[path];
  }

  /**
   * Get all known files from last sync
   */
  getKnownFiles(): Map<string, string> {
    return new Map(Object.entries(this.state.files));
  }

  /**
   * Update state for a file
   */
  setFileState(path: string, sha: string): void {
    this.state.files[path] = sha;
  }

  /**
   * Remove a file from state (after deletion)
   */
  removeFileState(path: string): void {
    delete this.state.files[path];
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.state = { lastSyncTime: '', files: {}, remoteShas: {} };
  }

  /**
   * Number of distinct paths recorded in either cache map
   */
  get cachedPathCount(): number {
    return new Set([...Object.keys(this.state.files), ...Object.keys(this.state.remoteShas)]).size;
  }

  /**
   * Get cached remote SHA for a file
   */
  getRemoteSha(path: string): string | undefined {
    return this.state.remoteShas[path];
  }

  /**
   * Get all cached remote SHAs
   */
  getAllRemoteShas(): Map<string, string> {
    return new Map(Object.entries(this.state.remoteShas));
  }

  /**
   * Update cached remote SHA for a file
   */
  setRemoteSha(path: string, sha: string): void {
    this.state.remoteShas[path] = sha;
  }

  /**
   * Remove cached remote SHA
   */
  removeRemoteSha(path: string): void {
    delete this.state.remoteShas[path];
  }

  /**
   * Update all remote SHAs at once
   */
  setAllRemoteShas(shas: Record<string, string>): void {
    this.state.remoteShas = shas;
  }

  /**
   * Get the HEAD SHA from last sync (for compare API rename detection)
   */
  getLastSyncHeadSha(): string | undefined {
    return this.state.lastSyncHeadSha;
  }

  /**
   * Set the HEAD SHA at sync time
   */
  setLastSyncHeadSha(sha: string): void {
    this.state.lastSyncHeadSha = sha;
  }

  /**
   * Get last sync time
   */
  getLastSyncTime(): string {
    return this.state.lastSyncTime;
  }

  /**
   * Detect changes between current state and new state
   * Returns what actions need to be taken
   */
  detectChanges(
    currentLocal: Map<string, string>,  // path -> content hash
    currentRemote: Map<string, string>  // path -> sha
  ): SyncActions {
    const lastKnown = this.getKnownFiles();
    const actions: SyncActions = {
      pushToRemote: [],    // New or modified locally
      pullFromRemote: [],  // New or modified remotely
      deleteFromRemote: [], // Deleted locally
      deleteFromLocal: [],  // Deleted remotely
      conflicts: [],        // Modified on both sides
      needsContentComparison: [], // New on both sides - need to compare actual content
    };

    // Find all unique paths
    const allPaths = new Set([
      ...lastKnown.keys(),
      ...currentLocal.keys(),
      ...currentRemote.keys(),
    ]);

    for (const path of allPaths) {
      const wasKnown = lastKnown.has(path);
      const existsLocal = currentLocal.has(path);
      const existsRemote = currentRemote.has(path);

      if (!wasKnown) {
        // New file (didn't exist at last sync)
        if (existsLocal && !existsRemote) {
          actions.pushToRemote.push(path);
        } else if (!existsLocal && existsRemote) {
          actions.pullFromRemote.push(path);
        } else if (existsLocal && existsRemote) {
          // New on both sides - need to compare actual content
          actions.needsContentComparison.push(path);
        }
      } else {
        // File existed at last sync
        const lastSha = lastKnown.get(path)!;
        const localChanged = existsLocal && currentLocal.get(path) !== lastSha;
        const remoteChanged = existsRemote && currentRemote.get(path) !== lastSha;

        this.log(`${path}:`, {
          lastSha: lastSha?.substring(0, 8),
          localHash: currentLocal.get(path)?.substring(0, 8),
          remoteSha: currentRemote.get(path)?.substring(0, 8),
          localChanged,
          remoteChanged,
        });

        if (existsLocal && existsRemote) {
          if (localChanged && remoteChanged) {
            // Modified on both sides - conflict
            actions.conflicts.push(path);
          } else if (localChanged) {
            // Only modified locally
            actions.pushToRemote.push(path);
          } else if (remoteChanged) {
            // Only modified remotely
            actions.pullFromRemote.push(path);
          }
          // else: no changes on either side
        } else if (existsLocal && !existsRemote) {
          if (localChanged) {
            // Modified locally, deleted remotely - conflict
            actions.conflicts.push(path);
          } else {
            // Deleted remotely
            actions.deleteFromLocal.push(path);
          }
        } else if (!existsLocal && existsRemote) {
          if (remoteChanged) {
            // Deleted locally, modified remotely - conflict
            actions.conflicts.push(path);
          } else {
            // Deleted locally
            actions.deleteFromRemote.push(path);
          }
        } else {
          // Deleted on both sides - no action needed
        }
      }
    }

    return actions;
  }
}

export interface SyncActions {
  pushToRemote: string[];
  pullFromRemote: string[];
  deleteFromRemote: string[];
  deleteFromLocal: string[];
  conflicts: string[];
  needsContentComparison: string[]; // Files that exist on both sides but are "new" - need content comparison
}
