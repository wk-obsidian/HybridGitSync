/**
 * Logging system with levels and file output
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export class Logger {
  private level: LogLevel;
  private prefix: string;
  private logs: LogEntry[] = [];
  private maxLogs: number = 1000;

  constructor(prefix: string = 'HybridGitSync', level: LogLevel = LogLevel.INFO) {
    this.prefix = prefix;
    this.level = level;
  }

  /**
   * Set log level
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Debug log
   */
  debug(...args: unknown[]): void {
    if (this.level <= LogLevel.DEBUG) {
      this.log(LogLevel.DEBUG, ...args);
    }
  }

  /**
   * Info log
   */
  info(...args: unknown[]): void {
    if (this.level <= LogLevel.INFO) {
      this.log(LogLevel.INFO, ...args);
    }
  }

  /**
   * Warning log
   */
  warn(...args: unknown[]): void {
    if (this.level <= LogLevel.WARN) {
      this.log(LogLevel.WARN, ...args);
    }
  }

  /**
   * Error log
   */
  error(...args: unknown[]): void {
    if (this.level <= LogLevel.ERROR) {
      this.log(LogLevel.ERROR, ...args);
    }
  }

  /**
   * Internal log method
   */
  private log(level: LogLevel, ...args: unknown[]): void {
    const timestamp = new Date().toISOString();
    const levelStr = LogLevel[level].padEnd(5);
    const message = `[${this.prefix}] [${levelStr}] ${timestamp}`;

    // Console output
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(message, ...args);
        break;
      case LogLevel.INFO:
        console.log(message, ...args);
        break;
      case LogLevel.WARN:
        console.warn(message, ...args);
        break;
      case LogLevel.ERROR:
        console.error(message, ...args);
        break;
    }

    // Store in memory
    this.logs.push({
      timestamp,
      level,
      message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
    });

    // Trim old logs
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
  }

  /**
   * Get all logs
   */
  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  /**
   * Get logs as string
   */
  getLogsAsString(): string {
    return this.logs.map(entry =>
      `${entry.timestamp} [${LogLevel[entry.level]}] ${entry.message}`
    ).join('\n');
  }

  /**
   * Clear logs
   */
  clearLogs(): void {
    this.logs = [];
  }

  /**
   * Export logs as JSON
   */
  exportLogs(): string {
    return JSON.stringify(this.logs, null, 2);
  }
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
}
