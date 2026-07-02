/**
 * Network status detection
 */
export class NetworkStatus {
  private online: boolean = navigator.onLine;
  private listeners: ((online: boolean) => void)[] = [];

  constructor() {
    window.addEventListener('online', () => this.updateStatus(true));
    window.addEventListener('offline', () => this.updateStatus(false));
  }

  private updateStatus(online: boolean): void {
    if (this.online !== online) {
      this.online = online;
      this.listeners.forEach(listener => listener(online));
    }
  }

  /**
   * Check if currently online
   */
  isOnline(): boolean {
    return this.online;
  }

  /**
   * Register a listener for network status changes
   */
  onChange(listener: (online: boolean) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Wait until online
   */
  async waitUntilOnline(): Promise<void> {
    if (this.online) return;
    return new Promise(resolve => {
      const unsubscribe = this.onChange(online => {
        if (online) {
          unsubscribe();
          resolve();
        }
      });
    });
  }
}
