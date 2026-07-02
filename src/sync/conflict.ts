import { Vault } from 'obsidian';
import { ApiBackend } from '../backend/api-backend';
import { SyncStateManager } from './state';

export type ConflictResolution = 'local' | 'remote' | 'both' | 'skip';

export interface ConflictInfo {
  path: string;
  localContent: string;
  remoteContent: string;
  localModified: Date;
  remoteModified: Date;
}

/**
 * Conflict detection and resolution
 */
export class ConflictResolver {
  private vault: Vault;
  private backend: ApiBackend;
  private stateManager: SyncStateManager;

  constructor(vault: Vault, backend: ApiBackend, stateManager: SyncStateManager) {
    this.vault = vault;
    this.backend = backend;
    this.stateManager = stateManager;
  }

  /**
   * Generate Git-compatible blob SHA-1
   */
  private async gitBlobSha1(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const contentBytes = encoder.encode(content);
    const header = encoder.encode(`blob ${contentBytes.length}\0`);

    const combined = new Uint8Array(header.length + contentBytes.length);
    combined.set(header);
    combined.set(contentBytes, header.length);

    const hashBuffer = await crypto.subtle.digest('SHA-1', combined);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Detect conflicts between local and remote files
   * A conflict occurs when both local and remote have different changes
   */
  async detectConflicts(localFiles: Map<string, string>): Promise<ConflictInfo[]> {
    const conflicts: ConflictInfo[] = [];

    // Get remote files
    const remoteFiles = await this.backend.listFilesRecursive('');
    const remoteMap = new Map<string, { sha: string; content?: string }>();
    for (const f of remoteFiles) {
      remoteMap.set(f.path, { sha: f.sha });
    }

    // Check each local file
    for (const [localPath, localContent] of localFiles) {
      const remote = remoteMap.get(localPath);
      if (!remote) {
        // File exists locally but not remotely - not a conflict, just new
        continue;
      }

      // Get remote content
      const remoteFile = await this.backend.getFile(localPath);
      if (!remoteFile) continue;

      // Compare contents
      if (remoteFile.content !== localContent) {
        // Both sides have different content - this is a conflict
        conflicts.push({
          path: localPath,
          localContent,
          remoteContent: remoteFile.content,
          localModified: new Date(), // We don't track local modification time yet
          remoteModified: new Date(),
        });
      }
    }

    return conflicts;
  }

  /**
   * Resolve a conflict with the given strategy
   */
  async resolve(conflict: ConflictInfo, resolution: ConflictResolution): Promise<void> {
    switch (resolution) {
      case 'local':
        // Keep local version, push to remote
        const newSha = await this.backend.putFile(conflict.path, conflict.localContent);
        // Update sync state with local content hash
        const localHash = await this.gitBlobSha1(conflict.localContent);
        this.stateManager.setFileState(conflict.path, localHash);
        // Update cached remote SHA
        this.stateManager.setRemoteSha(conflict.path, newSha);
        break;

      case 'remote':
        // Keep remote version, write to local
        await this.vault.adapter.write(conflict.path, conflict.remoteContent);
        // Update sync state with remote content hash
        const remoteHash = await this.gitBlobSha1(conflict.remoteContent);
        this.stateManager.setFileState(conflict.path, remoteHash);
        // Remote SHA stays the same (we're using remote's version)
        break;

      case 'both':
        // Save both versions
        const ext = conflict.path.lastIndexOf('.');
        const baseName = ext > -1 ? conflict.path.substring(0, ext) : conflict.path;
        const extension = ext > -1 ? conflict.path.substring(ext) : '';

        const localPath = `${baseName}.local${extension}`;
        const remotePath = `${baseName}.remote${extension}`;

        await this.vault.adapter.write(localPath, conflict.localContent);
        await this.vault.adapter.write(remotePath, conflict.remoteContent);
        // Update sync state for both files
        this.stateManager.setFileState(localPath, await this.gitBlobSha1(conflict.localContent));
        this.stateManager.setFileState(remotePath, await this.gitBlobSha1(conflict.remoteContent));
        // Remove original path from state
        this.stateManager.removeFileState(conflict.path);
        this.stateManager.removeRemoteSha(conflict.path);
        break;

      case 'skip':
        // Do nothing - keep the conflict for next sync
        break;
    }

    // Save state after resolution
    await this.stateManager.save();
  }

  /**
   * Generate a simple diff between two texts
   */
  generateDiff(local: string, remote: string): DiffResult {
    const localLines = local.split('\n');
    const remoteLines = remote.split('\n');
    const changes: DiffLine[] = [];

    const maxLen = Math.max(localLines.length, remoteLines.length);
    for (let i = 0; i < maxLen; i++) {
      const localLine = i < localLines.length ? localLines[i] : undefined;
      const remoteLine = i < remoteLines.length ? remoteLines[i] : undefined;

      if (localLine === undefined) {
        changes.push({ type: 'added', line: remoteLine!, lineNum: i + 1 });
      } else if (remoteLine === undefined) {
        changes.push({ type: 'removed', line: localLine, lineNum: i + 1 });
      } else if (localLine !== remoteLine) {
        changes.push({ type: 'modified', line: localLine, lineNum: i + 1, newLine: remoteLine });
      } else {
        changes.push({ type: 'unchanged', line: localLine, lineNum: i + 1 });
      }
    }

    return {
      changes,
      added: changes.filter(c => c.type === 'added').length,
      removed: changes.filter(c => c.type === 'removed').length,
      modified: changes.filter(c => c.type === 'modified').length,
    };
  }
}

export interface DiffLine {
  type: 'added' | 'removed' | 'modified' | 'unchanged';
  line: string;
  lineNum: number;
  newLine?: string;
}

export interface DiffResult {
  changes: DiffLine[];
  added: number;
  removed: number;
  modified: number;
}
