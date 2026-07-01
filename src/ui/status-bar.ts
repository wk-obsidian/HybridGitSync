import { ItemView, WorkspaceLeaf } from 'obsidian';

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
          return `Synced ${ago}`;
        }
        return 'Ready';
      case 'syncing': return 'Syncing...';
      case 'error': return 'Sync failed';
      case 'conflict': return 'Conflicts detected';
      case 'offline': return 'Offline';
    }
  }

  private getTimeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }
}
