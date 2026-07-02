import { ItemView, WorkspaceLeaf, TFile, moment } from 'obsidian';

export const HISTORY_VIEW_TYPE = 'hybrid-git-sync-history';

interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
  files: string[];
}

/**
 * History view panel showing commit history
 */
export class HistoryView extends ItemView {
  private commits: CommitInfo[] = [];
  private selectedCommit: CommitInfo | null = null;
  private onCommitSelect: ((commit: CommitInfo) => void) | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return HISTORY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Git History';
  }

  getIcon(): string {
    return 'history';
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  async onClose(): Promise<void> {
    // Cleanup
  }

  /**
   * Set commit history data
   */
  setCommits(commits: CommitInfo[]): void {
    this.commits = commits;
    this.render();
  }

  /**
   * Set callback for commit selection
   */
  onCommitSelected(callback: (commit: CommitInfo) => void): void {
    this.onCommitSelect = callback;
  }

  /**
   * Render the view
   */
  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('git-history-view');

    // Header
    const header = contentEl.createDiv('history-header');
    header.createEl('h3', { text: 'Commit History' });

    // Commit list
    const listEl = contentEl.createDiv('history-list');

    if (this.commits.length === 0) {
      listEl.createDiv({ cls: 'history-empty', text: 'No commits found' });
      return;
    }

    for (const commit of this.commits) {
      const commitEl = listEl.createDiv('history-commit');
      if (this.selectedCommit?.sha === commit.sha) {
        commitEl.addClass('selected');
      }

      // Commit message
      const msgEl = commitEl.createDiv('commit-message');
      msgEl.createSpan({ text: commit.message, cls: 'commit-msg-text' });

      // Commit details
      const detailsEl = commitEl.createDiv('commit-details');
      detailsEl.createSpan({ text: commit.author, cls: 'commit-author' });
      detailsEl.createSpan({ text: ' · ', cls: 'commit-separator' });
      detailsEl.createSpan({
        text: moment(commit.date).fromNow(),
        cls: 'commit-date',
      });
      detailsEl.createSpan({ text: ' · ', cls: 'commit-separator' });
      detailsEl.createSpan({
        text: commit.sha.substring(0, 7),
        cls: 'commit-sha',
      });

      // File count
      if (commit.files.length > 0) {
        const filesEl = commitEl.createDiv('commit-files');
        filesEl.createSpan({
          text: `${commit.files.length} file(s) changed`,
          cls: 'commit-file-count',
        });
      }

      // Click handler
      commitEl.addEventListener('click', () => {
        this.selectedCommit = commit;
        this.onCommitSelect?.(commit);
        this.render();
      });
    }
  }
}
