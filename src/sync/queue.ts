/**
 * Sync queue with debouncing to prevent frequent sync operations
 */
export class SyncQueue {
  private queue: (() => Promise<void>)[] = [];
  private isProcessing = false;
  private debounceTimer: number | null = null;
  private debounceMs: number;

  constructor(debounceMs: number = 5000) {
    this.debounceMs = debounceMs;
  }

  /**
   * Add a sync operation to the queue with debouncing
   * If called multiple times within debounceMs, only the last one executes
   */
  enqueue(operation: () => Promise<void>): void {
    // Clear existing debounce timer
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }

    // Set new debounce timer
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      this.queue.push(operation);
      this.processQueue();
    }, this.debounceMs);
  }

  /**
   * Add a sync operation immediately (no debounce)
   */
  enqueueImmediate(operation: () => Promise<void>): void {
    this.queue.push(operation);
    this.processQueue();
  }

  /**
   * Process the queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    while (this.queue.length > 0) {
      const operation = this.queue.shift();
      if (operation) {
        try {
          await operation();
        } catch (error) {
          console.error('[SyncQueue] Operation failed:', error);
        }
      }
    }
    this.isProcessing = false;
  }

  /**
   * Check if queue is processing
   */
  get busy(): boolean {
    return this.isProcessing;
  }

  /**
   * Clear pending operations
   */
  clear(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.queue = [];
  }

  /**
   * Update debounce interval
   */
  setDebounceMs(ms: number): void {
    this.debounceMs = ms;
  }
}
