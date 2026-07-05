import { ItemView, WorkspaceLeaf } from 'obsidian';

export const CHANGES_VIEW_TYPE = 'hybrid-git-sync-changes';

interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
}

/**
 * Sidebar panel showing changed files
 */
export class ChangesView extends ItemView {
  private changes: FileChange[] = [];
  private onFileClick: ((path: string) => void) | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return CHANGES_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Changes';
  }

  getIcon(): string {
    return 'git-branch';
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  async onClose(): Promise<void> {
    // Cleanup
  }

  /**
   * Set changes data
   */
  setChanges(changes: FileChange[]): void {
    this.changes = changes;
    this.render();
  }

  /**
   * Set callback for file click
   */
  onFileClicked(callback: (path: string) => void): void {
    this.onFileClick = callback;
  }

  /**
   * Render the view
   */
  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('changes-view');

    // Header
    const header = contentEl.createDiv('changes-header');
    header.createEl('h4', { text: 'Changed Files' });
    const countEl = header.createSpan({ cls: 'changes-count' });
    countEl.setText(`(${this.changes.length})`);

    // Changes list
    const listEl = contentEl.createDiv('changes-list');

    if (this.changes.length === 0) {
      listEl.createDiv({ cls: 'changes-empty', text: 'No changes' });
      return;
    }

    // Group by status
    const groups = this.groupByStatus(this.changes);

    for (const [status, files] of Object.entries(groups)) {
      if (files.length === 0) continue;

      const groupEl = listEl.createDiv('changes-group');
      const groupHeader = groupEl.createDiv('changes-group-header');
      groupHeader.createSpan({
        text: `${this.getStatusLabel(status)} (${files.length})`,
        cls: `changes-status-label changes-status-${status}`,
      });

      for (const file of files) {
        const fileEl = groupEl.createDiv('changes-file');

        // Status icon
        const iconEl = fileEl.createSpan({ cls: 'changes-file-icon' });
        iconEl.setText(this.getStatusIcon(file.status));

        // File path
        const pathEl = fileEl.createSpan({ cls: 'changes-file-path' });
        pathEl.setText(file.path);

        // Click handler
        fileEl.addEventListener('click', () => {
          this.onFileClick?.(file.path);
        });

        // Tooltip
        fileEl.setAttribute('title', file.path);
      }
    }
  }

  /**
   * Group changes by status
   */
  private groupByStatus(changes: FileChange[]): Record<string, FileChange[]> {
    const groups: Record<string, FileChange[]> = {
      added: [],
      modified: [],
      deleted: [],
      renamed: [],
    };

    for (const change of changes) {
      groups[change.status].push(change);
    }

    return groups;
  }

  /**
   * Get status label
   */
  private getStatusLabel(status: string): string {
    switch (status) {
      case 'added':
        return 'Added';
      case 'modified':
        return 'Modified';
      case 'deleted':
        return 'Deleted';
      case 'renamed':
        return 'Renamed';
      default:
        return status;
    }
  }

  /**
   * Get status icon
   */
  private getStatusIcon(status: string): string {
    switch (status) {
      case 'added':
        return 'A';
      case 'modified':
        return 'M';
      case 'deleted':
        return 'D';
      case 'renamed':
        return 'R';
      default:
        return '?';
    }
  }
}
