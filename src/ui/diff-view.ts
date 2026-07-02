import { ItemView, WorkspaceLeaf, moment } from 'obsidian';

export const DIFF_VIEW_TYPE = 'hybrid-git-sync-diff';

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged' | 'header';
  content: string;
  lineNumOld?: number;
  lineNumNew?: number;
}

/**
 * Diff view showing file differences
 */
export class DiffView extends ItemView {
  private filePath: string = '';
  private oldContent: string = '';
  private newContent: string = '';
  private diffLines: DiffLine[] = [];

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return DIFF_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.filePath ? `Diff: ${this.filePath}` : 'File Diff';
  }

  getIcon(): string {
    return 'diff';
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  async onClose(): Promise<void> {
    // Cleanup
  }

  /**
   * Set diff data
   */
  setDiff(filePath: string, oldContent: string, newContent: string): void {
    this.filePath = filePath;
    this.oldContent = oldContent;
    this.newContent = newContent;
    this.diffLines = this.computeDiff(oldContent, newContent);
    this.render();
  }

  /**
   * Compute diff between two strings
   */
  private computeDiff(oldText: string, newText: string): DiffLine[] {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const result: DiffLine[] = [];

    // Simple LCS-based diff
    const lcs = this.longestCommonSubsequence(oldLines, newLines);
    let oldIdx = 0;
    let newIdx = 0;
    let lcsIdx = 0;

    while (oldIdx < oldLines.length || newIdx < newLines.length) {
      if (lcsIdx < lcs.length) {
        // Emit removed lines (in old but not in LCS)
        while (oldIdx < lcs[lcsIdx][0]) {
          result.push({
            type: 'removed',
            content: oldLines[oldIdx],
            lineNumOld: oldIdx + 1,
          });
          oldIdx++;
        }

        // Emit added lines (in new but not in LCS)
        while (newIdx < lcs[lcsIdx][1]) {
          result.push({
            type: 'added',
            content: newLines[newIdx],
            lineNumNew: newIdx + 1,
          });
          newIdx++;
        }

        // Emit unchanged line (in LCS)
        result.push({
          type: 'unchanged',
          content: oldLines[oldIdx],
          lineNumOld: oldIdx + 1,
          lineNumNew: newIdx + 1,
        });
        oldIdx++;
        newIdx++;
        lcsIdx++;
      } else {
        // Remaining lines
        if (oldIdx < oldLines.length) {
          result.push({
            type: 'removed',
            content: oldLines[oldIdx],
            lineNumOld: oldIdx + 1,
          });
          oldIdx++;
        }
        if (newIdx < newLines.length) {
          result.push({
            type: 'added',
            content: newLines[newIdx],
            lineNumNew: newIdx + 1,
          });
          newIdx++;
        }
      }
    }

    return result;
  }

  /**
   * Find longest common subsequence (returns pairs of indices)
   */
  private longestCommonSubsequence(
    oldLines: string[],
    newLines: string[]
  ): [number, number][] {
    const m = oldLines.length;
    const n = newLines.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      Array(n + 1).fill(0)
    );

    // Build LCS table
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (oldLines[i - 1] === newLines[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    // Backtrack to find the sequence
    const result: [number, number][] = [];
    let i = m,
      j = n;
    while (i > 0 && j > 0) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        result.unshift([i - 1, j - 1]);
        i--;
        j--;
      } else if (dp[i - 1][j] > dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }

    return result;
  }

  /**
   * Render the diff view
   */
  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('diff-view');

    // Header
    const header = contentEl.createDiv('diff-header');
    header.createEl('h3', { text: `Diff: ${this.filePath}` });

    // Stats
    const statsEl = header.createDiv('diff-stats');
    const added = this.diffLines.filter((l) => l.type === 'added').length;
    const removed = this.diffLines.filter((l) => l.type === 'removed').length;
    statsEl.createSpan({ text: `+${added}`, cls: 'diff-stat-added' });
    statsEl.createSpan({ text: `-${removed}`, cls: 'diff-stat-removed' });

    // Diff content
    const diffEl = contentEl.createDiv('diff-content');

    if (this.diffLines.length === 0) {
      diffEl.createDiv({ cls: 'diff-empty', text: 'No differences' });
      return;
    }

    for (const line of this.diffLines) {
      const lineEl = diffEl.createDiv(`diff-line diff-${line.type}`);

      // Line numbers
      const numEl = lineEl.createSpan({ cls: 'diff-line-num' });
      if (line.lineNumOld !== undefined) {
        numEl.createSpan({ text: String(line.lineNumOld), cls: 'diff-num-old' });
      } else {
        numEl.createSpan({ text: '', cls: 'diff-num-old' });
      }
      if (line.lineNumNew !== undefined) {
        numEl.createSpan({ text: String(line.lineNumNew), cls: 'diff-num-new' });
      } else {
        numEl.createSpan({ text: '', cls: 'diff-num-new' });
      }

      // Prefix
      const prefix =
        line.type === 'added'
          ? '+'
          : line.type === 'removed'
          ? '-'
          : ' ';
      lineEl.createSpan({ text: prefix, cls: 'diff-prefix' });

      // Content
      lineEl.createSpan({ text: line.content, cls: 'diff-content-text' });
    }
  }
}
