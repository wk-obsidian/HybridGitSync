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

  /** Dispose resources */
  abstract dispose(): void;
}

export interface SyncResult {
  success: boolean;
  message: string;
  pulled?: number;
  pushed?: number;
  conflicts?: string[];
  error?: Error;
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
