import { App, Modal } from 'obsidian';
import { ConflictInfo, ConflictResolution, DiffResult } from '../sync/conflict';
import { t } from '../i18n';
import { getErrorMessage } from '../utils/error';

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

    contentEl.createEl('h2', { text: t('ui.resolveConflict') });
    contentEl.createEl('p', { text: `File: ${this.conflict.path}` });

    // Diff stats
    const statsEl = contentEl.createDiv('conflict-stats');
    statsEl.createSpan({ text: `+${this.diff.added} added  `, cls: 'diff-added' });
    statsEl.createSpan({ text: `-${this.diff.removed} removed  `, cls: 'diff-removed' });
    statsEl.createSpan({ text: `~${this.diff.modified} modified`, cls: 'diff-modified' });

    // Diff view
    const diffEl = contentEl.createDiv('conflict-diff');

    for (const change of this.diff.changes) {
      const lineEl = diffEl.createDiv('conflict-diff-line');

      const prefix = change.type === 'added' ? '+' :
                     change.type === 'removed' ? '-' :
                     change.type === 'modified' ? '~' : ' ';

      const colorClass = change.type === 'added' ? 'conflict-diff-added' :
                         change.type === 'removed' ? 'conflict-diff-removed' :
                         change.type === 'modified' ? 'conflict-diff-modified' : '';

      lineEl.createSpan({ text: `${prefix} `, cls: 'conflict-diff-prefix' });
      lineEl.createSpan({ text: change.line, cls: colorClass });

      if (change.type === 'modified' && change.newLine) {
        lineEl.createEl('br');
        lineEl.createSpan({ text: `→ `, cls: 'conflict-diff-prefix' });
        lineEl.createSpan({ text: change.newLine, cls: 'conflict-diff-added' });
      }
    }

    // Action buttons
    const buttonEl = contentEl.createDiv('conflict-buttons');
    this.createButton(buttonEl, t('ui.keepLocal'), 'local', 'btn-local');
    this.createButton(buttonEl, t('ui.keepRemote'), 'remote', 'btn-remote');
    this.createButton(buttonEl, t('ui.merge'), 'merge', 'btn-merge');
    this.createButton(buttonEl, t('ui.saveBoth'), 'both', 'btn-both');
    this.createButton(buttonEl, t('ui.skip'), 'skip', 'btn-skip');
  }

  private createButton(parent: HTMLElement, text: string, resolution: ConflictResolution, cls: string): void {
    const btn = parent.createEl('button', { text, cls: `conflict-btn ${cls}` });

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.setText(t('ui.processing'));
      try {
        await this.onResolve(resolution);
        this.close();
      } catch (error) {
        console.error('[ConflictModal] Resolution failed:', error);
        btn.disabled = false;
        btn.setText(text);
        // Show error message in the modal
        const errorEl = this.contentEl.createDiv('conflict-error');
        errorEl.setText(`Error: ${getErrorMessage(error)}`);
        // Auto-remove after 5 seconds
        window.setTimeout(() => errorEl.remove(), 5000);
      }
    });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
