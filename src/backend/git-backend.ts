import { FileSystemAdapter, Platform, Vault } from 'obsidian';
import { SyncBackend, SyncResult, SyncStatus, FileChange } from './base';
import { t } from '../i18n';
import { getErrorMessage, toError } from '../utils/error';
import { Logger, LogLevel } from '../utils/logger';

export class GitBackend extends SyncBackend {
  readonly name = 'git';
  private vaultPath: string;
  private configuredGitPath: string;
  private resolvedGitPath: string | null = null;
  private resolvePromise: Promise<string> | null = null;
  private remoteUrl: string;
  private token: string;
  private commitMessage: string;
  private debug: boolean;
  private logger: Logger;

  constructor(vault: Vault, gitPath: string = 'git', remoteUrl: string = '', token: string = '', commitMessage?: string, debug = false) {
    super();
    // The vault's absolute path lives on the desktop-only FileSystemAdapter
    const adapter = vault.adapter as any;
    if (typeof adapter?.getBasePath === 'function') {
      this.vaultPath = adapter.getBasePath();
    } else if (typeof adapter?.basePath === 'string') {
      this.vaultPath = adapter.basePath;
    } else if (vault.adapter instanceof FileSystemAdapter) {
      this.vaultPath = vault.adapter.getBasePath();
    } else {
      this.vaultPath = '';
    }
    this.configuredGitPath = gitPath;
    this.remoteUrl = remoteUrl;
    this.token = token;
    this.commitMessage = commitMessage || '';
    this.debug = debug;
    this.logger = new Logger('GitBackend', debug ? LogLevel.DEBUG : LogLevel.INFO);
    this.log('GitBackend created', {
      vaultPath: this.vaultPath,
      gitPath: this.configuredGitPath,
      remoteUrl: this.remoteUrl,
      hasToken: !!this.token,
    });
  }

  get gitPath(): string {
    return this.resolvedGitPath ?? this.configuredGitPath;
  }

  getVaultPath(): string {
    return this.vaultPath;
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      this.logger.info(...args);
    }
  }

  /**
   * Get remote URL from git config
   */
  async getRemoteUrl(): Promise<string | null> {
    try {
      const url = await this.exec(['remote', 'get-url', 'origin']);
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
      const branch = await this.exec(['rev-parse', '--abbrev-ref', 'HEAD']);
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
      const version = (await this.exec(['--version'])).trim();
      this.log('isAvailable: git version =', version);

      // Check if current directory is a git repo
      const isInsideWorkTree = (await this.exec(['rev-parse', '--is-inside-work-tree'])).trim();
      this.log('isAvailable: isInsideWorkTree =', isInsideWorkTree, ', vaultPath =', this.vaultPath);

      // Auto-configure remote if remoteUrl is provided
      if (this.remoteUrl) {
        try {
          const remotes = await this.exec(['remote', '-v']);
          if (!remotes.trim()) {
            this.log('isAvailable: No remote configured, adding origin:', this.remoteUrl);
            await this.exec(['remote', 'add', 'origin', this.remoteUrl]);
          }
          // Always update URL with token for authentication
          if (this.token) {
            const authUrl = this.remoteUrl.replace(
              'https://',
              `https://x-access-token:${this.token}@`
            );
            await this.exec(['remote', 'set-url', 'origin', authUrl]);
            this.log('isAvailable: Updated remote URL with token');
          }
        } catch (error) {
          this.log('isAvailable: Remote config error (ignored):', getErrorMessage(error));
        }
      }

      this.log('isAvailable: Git backend is available');
      return true;
    } catch (error) {
      this.logger.warn('isAvailable: Git backend not available:', getErrorMessage(error));
      return false;
    }
  }

  async pull(): Promise<SyncResult> {
    try {
      this.log('pull: Pulling from remote...');
      const output = await this.exec(['pull', '--no-rebase']);
      const pulled = this.countChanges(output);
      this.log('pull: Success, pulled', pulled, 'files');
      return {
        success: true,
        message: output.trim(),
        pulled,
      };
    } catch (error) {
      this.logger.warn('pull: Pull failed:', getErrorMessage(error));
      return {
        success: false,
        message: 'Pull failed',
        error: toError(error),
      };
    }
  }

  async push(): Promise<SyncResult> {
    try {
      const branch = (await this.exec(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      this.log('push: Current branch:', branch);

      // Check if upstream is already set
      let hasUpstream = false;
      try {
        await this.exec(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]);
        hasUpstream = true;
      } catch {
        // No upstream set
      }
      this.log('push: Has upstream:', hasUpstream);

      // Use -u flag only if upstream is not set
      const pushArgs = hasUpstream ? ['push'] : ['push', '-u', 'origin', branch];
      this.log('push: Executing:', pushArgs.join(' '));
      const output = await this.exec(pushArgs);

      const pushed = this.countChanges(output);
      this.log('push: Success, pushed', pushed, 'files');
      return {
        success: true,
        message: output.trim(),
        pushed,
      };
    } catch (error) {
      this.logger.warn('push: Push failed:', getErrorMessage(error));
      return {
        success: false,
        message: `Push failed: ${getErrorMessage(error)}`,
        error: toError(error),
      };
    }
  }

  /**
   * Build commit message from template
   */
  private buildCommitMessage(): string {
    const now = new Date();
    const dateStr = now.toISOString().replace('T', ' ').substring(0, 19);
    return (this.commitMessage || 'vault backup: {{date}}')
      .replace('{{date}}', dateStr)
      .replace('{{path}}', 'batch');
  }

  async sync(): Promise<SyncResult> {
    try {
      this.log('sync: Starting git sync...');

      // Step 0: Check git state before syncing
      const stateCheck = await this.checkGitState();
      if (!stateCheck.ok) {
        this.log('sync: Git state check failed:', stateCheck.message);
        return {
          success: false,
          message: stateCheck.message,
          error: new Error(stateCheck.message),
        };
      }

      // Step 1: Stage all changes
      this.log('sync: Staging all changes...');
      await this.exec(['add', '-A']);

      // Step 2: Check if there are changes to commit
      const status = await this.exec(['status', '--porcelain']);
      const changedFiles = status.trim().split('\n').filter(line => line.trim());
      this.log('sync: Changed files:', changedFiles.length);

      if (status.trim()) {
        const message = this.buildCommitMessage();
        this.log('sync: Committing with message:', message);
        await this.exec(['commit', '-m', message]);
      } else {
        this.log('sync: No changes to commit');
      }

      // Step 3: Try to pull with merge (skip if remote is empty or no upstream)
      this.log('sync: Pulling from remote...');
      try {
        const pullOutput = await this.exec(['pull', '--no-rebase']);
        this.log('sync: Pull result:', pullOutput.trim());
      } catch (pullError) {
        // Remote might be empty or no upstream set — that's OK for first push
        const msg = (pullError as Error).message;
        if (msg.includes('couldn\'t find remote ref') ||
            msg.includes('no upstream') ||
            msg.includes('fatal: couldn\'t find remote ref') ||
            msg.includes('There is no tracking information')) {
          this.log('sync: No upstream or empty remote, will push');
        } else {
          this.logger.warn('sync: Pull failed:', msg);
          throw pullError; // Re-throw other errors
        }
      }

      // Step 4: Push
      this.log('sync: Pushing to remote...');
      const pushResult = await this.push();
      this.log('sync: Push result:', pushResult);
      return pushResult;
    } catch (error) {
      this.logger.error('sync: Sync failed:', getErrorMessage(error));
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
      const status = await this.exec(['status']);

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
      const branch = (await this.exec(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      this.log('status: Current branch:', branch);

      // Get ahead/behind counts
      let ahead = 0, behind = 0;
      try {
        const counts = await this.exec(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
        const [a, b] = counts.trim().split('\t').map(Number);
        ahead = a || 0;
        behind = b || 0;
        this.log('status: Ahead:', ahead, ', Behind:', behind);
      } catch {
        // No upstream configured
        this.log('status: No upstream configured');
      }

      // Get changed files
      const statusOutput = await this.exec(['status', '--porcelain']);
      const changedFiles = this.parseStatus(statusOutput);
      this.log('status: Changed files:', changedFiles.length);

      // Check for conflicts
      const hasConflicts = statusOutput.includes('UU') || statusOutput.includes('AA');
      if (hasConflicts) {
        this.log('status: Conflicts detected');
      }

      return { ahead, behind, changedFiles, branch, hasConflicts };
    } catch (error) {
      this.logger.warn('status: Failed to get status:', getErrorMessage(error));
      return {
        ahead: 0,
        behind: 0,
        changedFiles: [],
        branch: 'unknown',
        hasConflicts: false,
      };
    }
  }

  async initializeRepo(): Promise<SyncResult> {
    // Git backend doesn't need special initialization
    // User should have already run `git init` and `git remote add`
    return { success: true, message: 'No initialization needed for git backend' };
  }

  dispose(): void {
    // Nothing to dispose for native git
  }

  private getExecFile(): typeof import('child_process').execFile {
    // Node.js built-ins are unavailable on mobile, so refuse before touching
    // require(). child_process is "external" in esbuild and never bundled;
    // require() resolves it from Electron's Node.js runtime at call time.
    if (!Platform.isDesktop) {
      throw new Error('GitBackend requires desktop: Node.js child_process is unavailable on mobile');
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional require() for desktop-only Node.js child_process
    const cp = require('child_process'); // eslint-disable-line no-restricted-imports -- guarded by Platform.isDesktop above
    return cp.execFile;
  }

  private getPlatform(): 'win32' | 'darwin' | 'linux' | 'other' {
    if (typeof process !== 'undefined' && process.platform) {
      if (process.platform === 'win32') return 'win32';
      if (process.platform === 'darwin') return 'darwin';
      if (process.platform === 'linux') return 'linux';
    }
    if (Platform.isWin) return 'win32';
    if (Platform.isMacOS) return 'darwin';
    if (Platform.isLinux) return 'linux';
    return 'other';
  }

  private getCandidatePaths(): { isExplicit: boolean; candidates: string[] } {
    const raw = this.configuredGitPath ?? '';
    let trimmed = raw.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
    ) {
      trimmed = trimmed.slice(1, -1).trim();
    }

    if (!trimmed || trimmed === 'git') {
      const candidates: string[] = ['git'];
      const platform = this.getPlatform();
      const env = process.env;

      if (platform === 'win32') {
        if (env.ProgramFiles) {
          candidates.push(
            `${env.ProgramFiles}\\Git\\cmd\\git.exe`,
            `${env.ProgramFiles}\\Git\\bin\\git.exe`
          );
        }
        if (env.ProgramW6432 && env.ProgramW6432 !== env.ProgramFiles) {
          candidates.push(
            `${env.ProgramW6432}\\Git\\cmd\\git.exe`,
            `${env.ProgramW6432}\\Git\\bin\\git.exe`
          );
        }
        if (env['ProgramFiles(x86)']) {
          candidates.push(
            `${env['ProgramFiles(x86)']}\\Git\\cmd\\git.exe`,
            `${env['ProgramFiles(x86)']}\\Git\\bin\\git.exe`
          );
        }
        if (env.LOCALAPPDATA) {
          candidates.push(
            `${env.LOCALAPPDATA}\\Programs\\Git\\cmd\\git.exe`,
            `${env.LOCALAPPDATA}\\Programs\\Git\\bin\\git.exe`
          );
        }
      } else if (platform === 'darwin') {
        candidates.push('/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git');
      } else if (platform === 'linux') {
        candidates.push('/usr/bin/git', '/usr/local/bin/git', '/bin/git');
      }

      // Deduplicate candidates while preserving priority
      const seen = new Set<string>();
      const deduped: string[] = [];
      for (const cand of candidates) {
        const key = platform === 'win32' ? cand.toLowerCase() : cand;
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(cand);
        }
      }
      return { isExplicit: false, candidates: deduped };
    }

    return { isExplicit: true, candidates: [trimmed] };
  }

  private async testExecutable(file: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      try {
        const execFile = this.getExecFile();
        execFile(
          file,
          ['--version'],
          { cwd: this.vaultPath || undefined, env: process.env },
          (error, stdout) => {
            if (!error && typeof stdout === 'string' && stdout.includes('git version')) {
              resolve(true);
            } else {
              resolve(false);
            }
          }
        );
      } catch {
        resolve(false);
      }
    });
  }

  private async resolveGitExecutable(): Promise<string> {
    if (this.resolvedGitPath) {
      return this.resolvedGitPath;
    }
    if (this.resolvePromise) {
      return this.resolvePromise;
    }

    this.resolvePromise = (async () => {
      const { isExplicit, candidates } = this.getCandidatePaths();
      for (const candidate of candidates) {
        const ok = await this.testExecutable(candidate);
        if (ok) {
          this.resolvedGitPath = candidate;
          this.log('Resolved git executable:', candidate);
          return candidate;
        }
      }

      if (isExplicit) {
        throw new Error(`Configured Git executable not found or failed validation: ${candidates[0]}`);
      } else {
        throw new Error(`Git executable not found in PATH or standard locations (${candidates.join(', ')})`);
      }
    })();

    try {
      return await this.resolvePromise;
    } catch (err) {
      this.resolvePromise = null;
      throw err;
    }
  }

  private sanitizeOutput(text: string): string {
    if (!text) return '';
    let sanitized = text;
    if (this.token && this.token.length > 0) {
      sanitized = sanitized.split(this.token).join('***');
    }
    sanitized = sanitized.replace(/(https?:\/\/)([^:/\s@]+):([^@/\s]+)@/g, '$1$2:***@');
    sanitized = sanitized.replace(/(https?:\/\/)([^@/\s:]+)@/g, '$1***@');
    return sanitized;
  }

  async exec(args: readonly string[]): Promise<string> {
    const gitExe = await this.resolveGitExecutable();
    const execFile = this.getExecFile();

    return new Promise((resolve, reject) => {
      // Build environment with token for authentication
      const env = { ...process.env };
      // Git hooks (git-lfs pre-push, etc.) resolve helpers via PATH. Obsidian
      // is launched with a minimal PATH that often misses Homebrew locations,
      // so prepend the git binary's own directory plus common install dirs.
      const isWin = this.getPlatform() === 'win32';
      const pathSep = isWin ? ';' : ':';
      const extraDirs = isWin ? [] : ['/usr/local/bin', '/opt/homebrew/bin'];
      const slash = gitExe.lastIndexOf('/');
      const backslash = gitExe.lastIndexOf('\\');
      const lastSep = Math.max(slash, backslash);
      if (lastSep > 0) {
        extraDirs.unshift(gitExe.slice(0, lastSep));
      }
      // On Windows process.env key is usually 'Path' rather than 'PATH'.
      // Spreading creates a plain object where case matters.
      const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || (isWin ? 'Path' : 'PATH');
      const existingPath = env[pathKey] || '';
      if (extraDirs.length > 0) {
        env[pathKey] = extraDirs.join(pathSep) + (existingPath ? pathSep + existingPath : '');
      }
      if (pathKey !== 'PATH' && 'PATH' in env) {
        delete (env as Record<string, string | undefined>).PATH;
      }
      if (this.token) {
        // Use GIT_ASKPASS to provide credentials non-interactively
        // This tells git to use our token when it asks for credentials
        env.GIT_TERMINAL_PROMPT = '0'; // Disable interactive prompts
        env.GIT_ASKPASS = 'echo'; // Use echo as credential helper
        if (this.remoteUrl.includes('github.com')) {
          env.GITHUB_TOKEN = this.token;
        }
      }

      execFile(
        gitExe,
        args,
        {
          cwd: this.vaultPath || undefined,
          env,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error: Error | null, stdout: string, stderr: string) => {
          if (error) {
            const rawMessage = error.message.includes(stderr)
              ? error.message
              : `${error.message}\n${stderr}`;
            reject(new Error(this.sanitizeOutput(rawMessage)));
          } else {
            resolve(stdout);
          }
        }
      );
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
