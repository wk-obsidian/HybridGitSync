/**
 * Abstract backend interface for sync operations.
 * GitBackend (desktop) and ApiBackend (mobile) both implement this.
 */
export abstract class SyncBackend {
  abstract readonly name: string;

  /** Check if the backend is available and configured */
  abstract isAvailable(): Promise<boolean>;

  /** Pull remote changes to local */
  abstract pull(): Promise<SyncResult>;

  /** Push local changes to remote */
  abstract push(): Promise<SyncResult>;

  /** Full sync: pull -> resolve -> commit -> push */
  abstract sync(): Promise<SyncResult>;

  /** Get current sync status */
  abstract status(): Promise<SyncStatus>;

  /** Initialize an empty repository (create first commit) */
  abstract initializeRepo(): Promise<SyncResult>;

  /** Dispose resources */
  abstract dispose(): void;
}

export interface SyncResult {
  success: boolean;
  message: string;
  pulled?: number;
  pushed?: number;
  skipped?: Array<{ path: string; size: number; reason: string }>;
  conflicts?: string[];
  error?: Error;
  /** Machine-readable outcome code for special handling (e.g. remote-reset prompt) */
  code?: 'remote-reset' | 'unverifiable';
}

export interface SyncStatus {
  /** Number of local commits ahead of remote */
  ahead: number;
  /** Number of remote commits ahead of local */
  behind: number;
  /** Files with local changes */
  changedFiles: FileChange[];
  /** Current branch name */
  branch: string;
  /** Whether there are conflicts */
  hasConflicts: boolean;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string; // for renames
}
