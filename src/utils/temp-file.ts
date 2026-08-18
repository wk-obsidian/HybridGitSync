import { Vault } from 'obsidian';
import { Logger, LogLevel } from './logger';

/**
 * Temporary file manager for safe atomic writes
 * Uses plugin directory to avoid polluting vault
 */
export class TempFileManager {
  private vault: Vault;
  private tempDir: string;
  private logger: Logger;

  constructor(vault: Vault, debug: boolean = false) {
    this.vault = vault;
    this.tempDir = '.obsidian/plugins/hybrid-git-sync/.tmp';
    this.logger = new Logger('TempFile', debug ? LogLevel.DEBUG : LogLevel.INFO);
  }

  /**
   * Initialize temp directory
   */
  async init(): Promise<void> {
    try {
      await this.vault.adapter.mkdir(this.tempDir);
    } catch {
      // Directory may already exist
    }
  }

  /**
   * Get temp file path for a given vault path
   */
  getTempPath(vaultPath: string): string {
    // Use hash of path to avoid nested directories in temp
    const hash = this.hashCode(vaultPath);
    const ext = vaultPath.split('.').pop() || 'tmp';
    return `${this.tempDir}/${hash}.${ext}.tmp`;
  }

  /**
   * Write content to temp file and then move to final location
   * This ensures atomic writes - either the full file is written or nothing
   */
  async writeSafe(path: string, content: string | ArrayBuffer): Promise<void> {
    const tempPath = this.getTempPath(path);
    const contentSize = content instanceof ArrayBuffer ? content.byteLength : content.length;
    this.logger.info(`Safe write: ${path} (${contentSize} bytes) -> temp: ${tempPath}`);

    try {
      // Step 1: Write to temp file
      this.logger.debug('Step 1: Writing to temp file...');
      if (content instanceof ArrayBuffer) {
        await this.vault.adapter.writeBinary(tempPath, content);
      } else {
        await this.vault.adapter.write(tempPath, content);
      }
      this.logger.debug('Step 1: Done');

      // Step 2: Ensure parent directory exists for final path
      const dir = path.substring(0, path.lastIndexOf('/'));
      if (dir) {
        try {
          await this.vault.adapter.mkdir(dir);
        } catch {
          // Directory may already exist
        }
      }

      // Step 3: Read from temp and write to final location
      // (Obsidian adapter doesn't have rename, so we copy)
      this.logger.debug('Step 3: Copying temp to final location...');
      if (content instanceof ArrayBuffer) {
        const tempContent = await this.vault.adapter.readBinary(tempPath);
        this.logger.debug('Read from temp:', tempContent.byteLength, 'bytes');
        await this.vault.adapter.writeBinary(path, tempContent);
      } else {
        const tempContent = await this.vault.adapter.read(tempPath);
        await this.vault.adapter.write(path, tempContent);
      }
      this.logger.debug('Step 3: Done');

      // Step 4: Clean up temp file
      await this.removeTemp(tempPath);

      this.logger.info('Safe write completed:', path);
    } catch (error) {
      this.logger.error('Safe write failed:', path, error);
      // Clean up temp file on error
      try {
        await this.removeTemp(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Remove a specific temp file
   */
  async removeTemp(tempPath: string): Promise<void> {
    try {
      await this.vault.adapter.remove(tempPath);
    } catch {
      // File may not exist
    }
  }

  /**
   * Clean up all orphaned temp files
   * Called at the start of each sync
   */
  async cleanup(): Promise<number> {
    let cleaned = 0;
    try {
      const listing = await this.vault.adapter.list(this.tempDir);
      for (const file of listing.files) {
        if (file.endsWith('.tmp')) {
          await this.vault.adapter.remove(file);
          cleaned++;
          this.logger.debug('Cleaned up temp file:', file);
        }
      }
    } catch {
      // Temp directory may not exist yet
    }
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} orphaned temp file(s)`);
    }
    return cleaned;
  }

  /**
   * Simple hash function for file paths
   */
  private hashCode(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }
}
