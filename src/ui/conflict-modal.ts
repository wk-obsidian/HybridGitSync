import { App, Modal } from 'obsidian';
import { ConflictInfo, ConflictResolution, DiffResult } from '../sync/conflict';
import { t } from '../i18n';
import { getErrorMessage } from '../utils/error';
import { hasConflictMarkers } from '../utils/diff';

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
    this.renderInitialView();
  }

  private renderInitialView(): void {
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
    this.createActionButton(buttonEl, t('ui.keepLocal'), 'local', 'btn-local');
    this.createActionButton(buttonEl, t('ui.keepRemote'), 'remote', 'btn-remote');
    this.createActionButton(buttonEl, t('ui.merge'), 'merge', 'btn-merge');
    this.createActionButton(buttonEl, t('ui.saveBoth'), 'both', 'btn-both');
    this.createActionButton(buttonEl, t('ui.skip'), 'skip', 'btn-skip');
  }

  private renderMergeView(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: t('ui.mergeConflict') });
    contentEl.createEl('p', { text: `File: ${this.conflict.path}` });

    // Instructions
    const instructionsEl = contentEl.createDiv('merge-instructions');
    instructionsEl.createEl('p', { text: t('ui.mergeInstructions') });
    instructionsEl.createEl('p', { text: t('ui.mergeInstructionsDetail') });

    // Open file button
    const openBtn = instructionsEl.createEl('button', { text: t('ui.openFile') });
    openBtn.classList.add('mod-cta');
    openBtn.addEventListener('click', () => {
      // Open the file in the editor
      const file = this.app.vault.getAbstractFileByPath(this.conflict.path);
      if (file) {
        this.app.workspace.openLinkText(this.conflict.path, '', false);
      }
    });

    // Status message
    const statusEl = contentEl.createDiv('merge-status');
    statusEl.createEl('p', { text: t('ui.mergeWaiting'), cls: 'merge-status-text' });

    // Buttons
    const buttonEl = contentEl.createDiv('conflict-buttons');

    // Done button - check if conflict markers are removed
    const doneBtn = buttonEl.createEl('button', { text: t('ui.mergeDone'), cls: 'conflict-btn btn-merge' });
    doneBtn.addEventListener('click', async () => {
      await this.checkAndResolve();
    });

    // Cancel button
    const cancelBtn = buttonEl.createEl('button', { text: t('ui.cancel'), cls: 'conflict-btn btn-skip' });
    cancelBtn.addEventListener('click', () => {
      this.close();
    });
  }

  private async checkAndResolve(): Promise<void> {
    try {
      // Read the current file content
      const file = this.app.vault.getAbstractFileByPath(this.conflict.path);
      if (!file) {
        this.showError(t('ui.fileNotFound'));
        return;
      }

      const content = await this.app.vault.read(file as any);

      // Check if conflict markers still exist
      if (hasConflictMarkers(content)) {
        this.showError(t('ui.conflictMarkersStillExist'));
        return;
      }

      // Conflict markers removed - resolve the conflict
      await this.onResolve('merge');
      this.close();
    } catch (error) {
      this.showError(getErrorMessage(error));
    }
  }

  private showError(message: string): void {
    const errorEl = this.contentEl.createDiv('conflict-error');
    errorEl.setText(message);
    window.setTimeout(() => errorEl.remove(), 5000);
  }

  private createActionButton(parent: HTMLElement, text: string, resolution: ConflictResolution, cls: string): void {
    const btn = parent.createEl('button', { text, cls: `conflict-btn ${cls}` });

    btn.addEventListener('click', async () => {
      if (resolution === 'merge') {
        // For merge, write conflict markers and show merge view
        await this.onResolve('merge');
        this.renderMergeView();
      } else {
        // For other resolutions, process and close
        btn.disabled = true;
        btn.setText(t('ui.processing'));
        try {
          await this.onResolve(resolution);
          this.close();
        } catch (error) {
          console.error('[ConflictModal] Resolution failed:', error);
          btn.disabled = false;
          btn.setText(text);
          this.showError(getErrorMessage(error));
        }
      }
    });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
