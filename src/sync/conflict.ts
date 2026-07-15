import { Vault } from 'obsidian';
import { ApiBackend } from '../backend/api-backend';
import { SyncStateManager } from './state';
import { computeDiff, mergeWithoutMarkers } from '../utils/diff';
import type { DiffResult, DiffLine } from '../utils/diff';

export type ConflictResolution = 'local' | 'remote' | 'both' | 'merge' | 'skip';
// 'merge' = auto-merge with conflict markers and save to file

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
    console.log('[ConflictResolver] Resolving:', conflict.path, 'with strategy:', resolution);

    try {
      switch (resolution) {
        case 'local': {
          // Keep local version, push to remote (with retry)
          let retries = 3;
          let success = false;
          let currentSha: string | undefined;

          // Try to use cached SHA first
          const cachedSha = this.stateManager.getRemoteSha(conflict.path);
          if (cachedSha) {
            console.log('[ConflictResolver] Using cached remote SHA:', cachedSha);
            currentSha = cachedSha;
          }

          while (retries > 0 && !success) {
            // If no cached SHA, fetch from remote
            if (!currentSha) {
              console.log('[ConflictResolver] Fetching remote file SHA... (retries:', retries, ')');
              const remoteFile = await this.backend.getFile(conflict.path);
              currentSha = remoteFile?.sha;
              console.log('[ConflictResolver] Current remote SHA:', currentSha);
            }

            console.log('[ConflictResolver] Pushing local content to remote...');
            try {
              const newSha = await this.backend.putFile(conflict.path, conflict.localContent, currentSha);
              console.log('[ConflictResolver] Pushed, new SHA:', newSha);
              // Update sync state with local content hash
              const localHash = await this.gitBlobSha1(conflict.localContent);
              this.stateManager.setFileState(conflict.path, localHash);
              // Update cached remote SHA
              this.stateManager.setRemoteSha(conflict.path, newSha);
              success = true;
            } catch (e) {
              retries--;
              currentSha = undefined; // Reset SHA to force re-fetch
              if (retries === 0) throw e;
              console.warn('[ConflictResolver] Retry due to conflict...');
              await new Promise(r => window.setTimeout(r, 1000)); // Wait 1 second
            }
          }
          break;
        }

        case 'remote': {
          // Keep remote version, write to local
          console.log('[ConflictResolver] Writing remote content to local...');
          await this.vault.adapter.write(conflict.path, conflict.remoteContent);
          // Update sync state with remote content hash
          const remoteHash = await this.gitBlobSha1(conflict.remoteContent);
          this.stateManager.setFileState(conflict.path, remoteHash);
          // Remote SHA stays the same (we're using remote's version)
          break;
        }

        case 'both': {
          // Save both versions
          const ext = conflict.path.lastIndexOf('.');
          const baseName = ext > -1 ? conflict.path.substring(0, ext) : conflict.path;
          const extension = ext > -1 ? conflict.path.substring(ext) : '';

          const localPath = `${baseName}.local${extension}`;
          const remotePath = `${baseName}.remote${extension}`;

          console.log('[ConflictResolver] Saving both versions:', localPath, remotePath);
          await this.vault.adapter.write(localPath, conflict.localContent);
          await this.vault.adapter.write(remotePath, conflict.remoteContent);
          // Update sync state for both files
          this.stateManager.setFileState(localPath, await this.gitBlobSha1(conflict.localContent));
          this.stateManager.setFileState(remotePath, await this.gitBlobSha1(conflict.remoteContent));
          // Remove original path from state
          this.stateManager.removeFileState(conflict.path);
          this.stateManager.removeRemoteSha(conflict.path);
          break;
        }

        case 'merge': {
          // Auto-merge: combine both versions without conflict markers
          console.log('[ConflictResolver] Auto-merging:', conflict.path);

          const mergedContent = mergeWithoutMarkers(
            conflict.localContent,
            conflict.remoteContent
          );

          // Save merged content locally
          await this.vault.adapter.write(conflict.path, mergedContent);
          console.log('[ConflictResolver] Merged file written:', conflict.path);

          // Push merged content to remote
          const remoteFile = await this.backend.getFile(conflict.path);
          const currentSha = remoteFile?.sha;
          const newSha = await this.backend.putFile(conflict.path, mergedContent, currentSha);
          console.log('[ConflictResolver] Pushed to remote, new SHA:', newSha);

          // Update sync state
          const mergedHash = await this.gitBlobSha1(mergedContent);
          this.stateManager.setFileState(conflict.path, mergedHash);
          this.stateManager.setRemoteSha(conflict.path, newSha);
          console.log('[ConflictResolver] Sync state updated for:', conflict.path);
          break;
        }

        case 'skip':
          console.log('[ConflictResolver] Skipping conflict');
          // Do nothing - keep the conflict for next sync
          break;
      }

      // Save state after resolution
      console.log('[ConflictResolver] Saving state...');
      await this.stateManager.save();
      console.log('[ConflictResolver] Resolution complete');
    } catch (error) {
      console.error('[ConflictResolver] Error resolving conflict:', error);
      throw error; // Re-throw to let the modal handle it
    }
  }

  /**
   * Generate diff between two texts using diff library
   */
  generateDiff(local: string, remote: string): DiffResult {
    const result = computeDiff(local, remote);
    return {
      changes: result.lines.map(line => ({
        type: line.type === 'added' ? 'added' as const :
              line.type === 'removed' ? 'removed' as const :
              'unchanged' as const,
        line: line.content,
        lineNum: line.oldLineNum || line.newLineNum || 0,
        newLine: line.type === 'added' ? line.content : undefined,
      })),
      added: result.added,
      removed: result.removed,
      modified: 0, // diff library doesn't distinguish modified from added+removed
    };
  }
}
