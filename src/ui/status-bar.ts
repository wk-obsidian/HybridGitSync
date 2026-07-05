import { t } from '../i18n';

export type SyncState = 'idle' | 'syncing' | 'error' | 'conflict' | 'offline';

export class StatusBar {
  private statusBarEl: HTMLElement;
  private state: SyncState = 'idle';
  private lastSyncTime: Date | null = null;
  private message: string = '';

  constructor(statusBarEl: HTMLElement) {
    this.statusBarEl = statusBarEl;
    this.render();
  }

  setState(state: SyncState, message?: string): void {
    this.state = state;
    if (message) this.message = message;
    if (state === 'idle') this.lastSyncTime = new Date();
    this.render();
  }

  private render(): void {
    const icon = this.getStateIcon();
    const text = this.getStateText();
    this.statusBarEl.setText(`${icon} ${text}`);
    this.statusBarEl.setAttribute('title', this.message || text);
  }

  private getStateIcon(): string {
    switch (this.state) {
      case 'idle': return '✓';
      case 'syncing': return '↻';
      case 'error': return '✗';
      case 'conflict': return '⚠';
      case 'offline': return '○';
    }
  }

  private getStateText(): string {
    switch (this.state) {
      case 'idle':
        if (this.lastSyncTime) {
          const ago = this.getTimeAgo(this.lastSyncTime);
          return t('status.synced', { time: ago });
        }
        return t('status.ready');
      case 'syncing': return t('status.syncing');
      case 'error': return t('status.failed');
      case 'conflict': return t('status.conflicts');
      case 'offline': return t('status.offline');
    }
  }

  private getTimeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return t('time.justNow');
    if (seconds < 3600) return t('time.minutesAgo', { count: Math.floor(seconds / 60) });
    if (seconds < 86400) return t('time.hoursAgo', { count: Math.floor(seconds / 3600) });
    return t('time.daysAgo', { count: Math.floor(seconds / 86400) });
  }
}
