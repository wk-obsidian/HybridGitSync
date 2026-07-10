import { exec } from 'child_process';
import { Vault } from 'obsidian';
import { SyncBackend, SyncResult, SyncStatus, FileChange } from './base';
import { t } from '../i18n';
import { getErrorMessage, toError } from '../utils/error';

export class GitBackend extends SyncBackend {
  readonly name = 'git';
  private vaultPath: string;
  private gitPath: string;
  private remoteUrl: string;
  private token: string;

  constructor(vault: Vault, gitPath: string = 'git', remoteUrl: string = '', token: string = '') {
    super();
    // @ts-ignore - basePath is available on vault adapter
    this.vaultPath = vault.adapter.basePath || '';
    this.gitPath = gitPath;
    this.remoteUrl = remoteUrl;
    this.token = token;
  }

  /**
   * Get remote URL from git config
   */
  async getRemoteUrl(): Promise<string | null> {
    try {
      const url = await this.exec('remote get-url origin');
      return url.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Get current branch name
   */
  async getCurrentBranch(): Promise<string | null> {
    try {
      const branch = await this.exec('rev-parse --abbrev-ref HEAD');
      return branch.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Get remote repository info (auto-detect)
   */
  async getRepoInfo(): Promise<{ remoteUrl: string | null; branch: string | null }> {
    const remoteUrl = await this.getRemoteUrl();
    const branch = await this.getCurrentBranch();
    return { remoteUrl, branch };
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.exec('--version');
      // Check if current directory is a git repo
      await this.exec('rev-parse --is-inside-work-tree');

      // Auto-configure remote if remoteUrl is provided
      if (this.remoteUrl) {
        try {
          const remotes = await this.exec('remote -v');
          if (!remotes.trim()) {
            // No remote configured, add origin
            await this.exec(`remote add origin ${this.remoteUrl}`);
          }
          // Always update URL with token for authentication
          if (this.token) {
            const authUrl = this.remoteUrl.replace(
              'https://',
              `https://x-access-token:${this.token}@`
            );
            await this.exec(`remote set-url origin ${authUrl}`);
          }
        } catch {
          // Ignore remote config errors
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  async pull(): Promise<SyncResult> {
    try {
      const output = await this.exec('pull --no-rebase');
      return {
        success: true,
        message: output.trim(),
        pulled: this.countChanges(output),
      };
    } catch (error) {
      return {
        success: false,
        message: 'Pull failed',
        error: toError(error),
      };
    }
  }

  async push(): Promise<SyncResult> {
    try {
      const branch = (await this.exec('rev-parse --abbrev-ref HEAD')).trim();

      // Check if upstream is already set
      let hasUpstream = false;
      try {
        await this.exec(`rev-parse --abbrev-ref ${branch}@{upstream}`);
        hasUpstream = true;
      } catch {
        // No upstream set
      }

      // Use -u flag only if upstream is not set
      const pushCmd = hasUpstream ? 'push' : `push -u origin ${branch}`;
      const output = await this.exec(pushCmd);

      return {
        success: true,
        message: output.trim(),
        pushed: this.countChanges(output),
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
      // Step 0: Check git state before syncing
      const stateCheck = await this.checkGitState();
      if (!stateCheck.ok) {
        return {
          success: false,
          message: stateCheck.message,
          error: new Error(stateCheck.message),
        };
      }

      // Step 1: Stage all changes
      await this.exec('add -A');

      // Step 2: Check if there are changes to commit
      const status = await this.exec('status --porcelain');
      if (status.trim()) {
        const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
        await this.exec(`commit -m "sync: ${timestamp}"`);
      }

      // Step 3: Try to pull with merge (skip if remote is empty or no upstream)
      try {
        await this.exec('pull --no-rebase');
      } catch (pullError) {
        // Remote might be empty or no upstream set — that's OK for first push
        const msg = (pullError as Error).message;
        if (msg.includes('couldn\'t find remote ref') ||
            msg.includes('no upstream') ||
            msg.includes('fatal: couldn\'t find remote ref') ||
            msg.includes('There is no tracking information')) {
          // This is fine, just push
        } else {
          throw pullError; // Re-throw other errors
        }
      }

      // Step 4: Push
      const pushResult = await this.push();
      return pushResult;
    } catch (error) {
      return {
        success: false,
        message: `Sync failed: ${getErrorMessage(error)}`,
        error: toError(error),
      };
    }
  }

  /**
   * Check git state and return error if abnormal
   */
  private async checkGitState(): Promise<{ ok: boolean; message: string }> {
    try {
      const status = await this.exec('status');

      // Check for rebase in progress
      if (status.includes('rebase') || status.includes('REBASE')) {
        return {
          ok: false,
          message: t('conflict.rebaseInProgress'),
        };
      }

      // Check for merge in progress
      if (status.includes('merge') || status.includes('MERGE')) {
        return {
          ok: false,
          message: t('conflict.mergeInProgress'),
        };
      }

      // Check for cherry-pick in progress
      if (status.includes('cherry-pick') || status.includes('CHERRY_PICK')) {
        return {
          ok: false,
          message: t('conflict.cherryPickInProgress'),
        };
      }

      return { ok: true, message: '' };
    } catch (error) {
      // If git status fails, might be in a bad state
      return {
        ok: false,
        message: `Git state check failed: ${getErrorMessage(error)}`,
      };
    }
  }

  async status(): Promise<SyncStatus> {
    try {
      // Get current branch
      const branch = (await this.exec('rev-parse --abbrev-ref HEAD')).trim();

      // Get ahead/behind counts
      let ahead = 0, behind = 0;
      try {
        const counts = await this.exec('rev-list --left-right --count HEAD...@{upstream}');
        const [a, b] = counts.trim().split('\t').map(Number);
        ahead = a || 0;
        behind = b || 0;
      } catch {
        // No upstream configured
      }

      // Get changed files
      const statusOutput = await this.exec('status --porcelain');
      const changedFiles = this.parseStatus(statusOutput);

      // Check for conflicts
      const hasConflicts = statusOutput.includes('UU') || statusOutput.includes('AA');

      return { ahead, behind, changedFiles, branch, hasConflicts };
    } catch {
      return {
        ahead: 0,
        behind: 0,
        changedFiles: [],
        branch: 'unknown',
        hasConflicts: false,
      };
    }
  }

  dispose(): void {
    // Nothing to dispose for native git
  }

  private exec(args: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Build environment with token for authentication
      const env: Record<string, string> = { ...process.env };
      if (this.token) {
        // Use GIT_ASKPASS to provide credentials non-interactively
        // This tells git to use our token when it asks for credentials
        env.GIT_TERMINAL_PROMPT = '0'; // Disable interactive prompts
        env.GIT_ASKPASS = 'echo'; // Use echo as credential helper
        if (this.remoteUrl.includes('github.com')) {
          env.GITHUB_TOKEN = this.token;
        }
      }

      exec(`${this.gitPath} ${args}`, {
        cwd: this.vaultPath,
        env
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stderr}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  private parseStatus(output: string): FileChange[] {
    const changes: FileChange[] = [];
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      const statusCode = line.substring(0, 2);
      const path = line.substring(3).trim();

      let status: FileChange['status'];
      if (statusCode.includes('A')) status = 'added';
      else if (statusCode.includes('D')) status = 'deleted';
      else if (statusCode.includes('R')) status = 'renamed';
      else status = 'modified';

      changes.push({ path, status });
    }
    return changes;
  }

  private countChanges(output: string): number {
    const match = output.match(/(\d+) file/);
    return match ? parseInt(match[1]) : 0;
  }
}
