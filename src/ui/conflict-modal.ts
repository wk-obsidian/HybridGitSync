import { App, Modal, Setting } from 'obsidian';
import { ConflictInfo, ConflictResolution, DiffResult, DiffLine } from '../sync/conflict';

/**
 * Modal for resolving file conflicts
 */
export class ConflictModal extends Modal {
  private conflict: ConflictInfo;
  private diff: DiffResult;
  private onResolve: (resolution: ConflictResolution) => Promise<void>;

  constructor(
    app: App,
    conflict: ConflictInfo,
    diff: DiffResult,
    onResolve: (resolution: ConflictResolution) => Promise<void>
  ) {
    super(app);
    this.conflict = conflict;
    this.diff = diff;
    this.onResolve = onResolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Resolve Conflict' });
    contentEl.createEl('p', { text: `File: ${this.conflict.path}` });

    // Diff stats
    const statsEl = contentEl.createDiv('conflict-stats');
    statsEl.createSpan({ text: `+${this.diff.added} added  `, cls: 'diff-added' });
    statsEl.createSpan({ text: `-${this.diff.removed} removed  `, cls: 'diff-removed' });
    statsEl.createSpan({ text: `~${this.diff.modified} modified`, cls: 'diff-modified' });

    // Diff view
    const diffEl = contentEl.createDiv('conflict-diff');
    diffEl.style.maxHeight = '300px';
    diffEl.style.overflow = 'auto';
    diffEl.style.fontFamily = 'monospace';
    diffEl.style.fontSize = '12px';
    diffEl.style.padding = '8px';
    diffEl.style.backgroundColor = 'var(--background-secondary)';
    diffEl.style.borderRadius = '4px';
    diffEl.style.marginTop = '8px';

    for (const change of this.diff.changes) {
      const lineEl = diffEl.createDiv();
      lineEl.style.padding = '1px 4px';
      lineEl.style.whiteSpace = 'pre-wrap';
      lineEl.style.wordBreak = 'break-all';

      const prefix = change.type === 'added' ? '+' :
                     change.type === 'removed' ? '-' :
                     change.type === 'modified' ? '~' : ' ';
      const color = change.type === 'added' ? 'var(--text-success)' :
                    change.type === 'removed' ? 'var(--text-error)' :
                    change.type === 'modified' ? 'var(--text-warning)' : '';

      lineEl.createSpan({ text: `${prefix} `, style: { color: 'var(--text-muted)', userSelect: 'none' } });
      lineEl.createSpan({ text: change.line, style: { color } });

      if (change.type === 'modified' && change.newLine) {
        lineEl.createEl('br');
        lineEl.createSpan({ text: `→ `, style: { color: 'var(--text-muted)', userSelect: 'none' } });
        lineEl.createSpan({ text: change.newLine, style: { color: 'var(--text-success)' } });
      }
    }

    // Action buttons
    const buttonEl = contentEl.createDiv('conflict-buttons');
    buttonEl.style.display = 'flex';
    buttonEl.style.gap = '8px';
    buttonEl.style.marginTop = '16px';
    buttonEl.style.justifyContent = 'flex-end';

    this.createButton(buttonEl, 'Keep Local', 'local', 'var(--text-accent)');
    this.createButton(buttonEl, 'Keep Remote', 'remote', 'var(--text-warning)');
    this.createButton(buttonEl, 'Save Both', 'both', 'var(--text-muted)');
    this.createButton(buttonEl, 'Skip', 'skip', 'var(--text-faint)');
  }

  private createButton(parent: HTMLElement, text: string, resolution: ConflictResolution, color: string): void {
    const btn = parent.createEl('button', { text });
    btn.style.padding = '6px 16px';
    btn.style.borderRadius = '4px';
    btn.style.border = `1px solid ${color}`;
    btn.style.backgroundColor = 'transparent';
    btn.style.color = color;
    btn.style.cursor = 'pointer';

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.setText('Processing...');
      try {
        await this.onResolve(resolution);
        this.close();
      } catch (error) {
        console.error('[ConflictModal] Resolution failed:', error);
        btn.disabled = false;
        btn.setText(text);
      }
    });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
