import { App, Modal } from 'obsidian';
import { t } from '../i18n';

/**
 * Modal to show OAuth device code and wait for authorization
 */
export class OAuthModal extends Modal {
  private userCode: string;
  private verificationUri: string;
  private timerEl!: HTMLElement;
  private secondsLeft: number = 300; // 5 minutes

  constructor(app: App, userCode: string, verificationUri: string) {
    super(app);
    this.userCode = userCode;
    this.verificationUri = verificationUri;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: t('oauth.title') });

    // Instructions
    contentEl.createEl('p', { text: t('oauth.step1') });

    // Code display (large, easy to read, selectable)
    const codeEl = contentEl.createDiv('oauth-code');
    const codeSpan = codeEl.createEl('span', { text: this.userCode, cls: 'oauth-code-text' });

    // Copy button
    const copyRow = contentEl.createDiv('oauth-copy-row');
    const copyBtn = copyRow.createEl('button', { text: t('oauth.copyCode') });
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(this.userCode).then(() => {
        copyBtn.setText(t('oauth.copied'));
        window.setTimeout(() => copyBtn.setText(t('oauth.copyCode')), 2000);
      });
    });

    // URL
    contentEl.createEl('p', { text: t('oauth.step2') });
    const linkEl = contentEl.createEl('a', {
      text: this.verificationUri,
      href: this.verificationUri,
      cls: 'oauth-link',
    });

    // Open browser button
    const btnRow = contentEl.createDiv('oauth-buttons');
    const openBtn = btnRow.createEl('button', { text: t('oauth.openBrowser') });
    openBtn.classList.add('mod-cta');
    openBtn.addEventListener('click', () => {
      window.open(this.verificationUri, '_blank');
    });

    // Timer
    this.timerEl = contentEl.createDiv('oauth-timer');
    this.updateTimer();

    // Start countdown
    const interval = window.setInterval(() => {
      this.secondsLeft--;
      this.updateTimer();
      if (this.secondsLeft <= 0) {
        window.clearInterval(interval);
        this.close();
      }
    }, 1000);

    // Cancel button
    const cancelRow = contentEl.createDiv('oauth-cancel-row');
    const cancelBtn = cancelRow.createEl('button', { text: t('oauth.cancel') });
    cancelBtn.addEventListener('click', () => {
      window.clearInterval(interval);
      this.close();
    });
  }

  private updateTimer(): void {
    const minutes = Math.floor(this.secondsLeft / 60);
    const seconds = this.secondsLeft % 60;
    this.timerEl.setText(t('oauth.expiresIn', {
      time: `${minutes}:${seconds.toString().padStart(2, '0')}`,
    }));
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
