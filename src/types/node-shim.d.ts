/**
 * Desktop-only Node typings.
 *
 * Obsidian's review environment (mobile-first) does not load @types/node, so
 * any use of Node built-ins there collapses to `any` and triggers the whole
 * no-unsafe-* family. Declaring exactly the Node surface this plugin uses
 * keeps local typecheck and the review environment consistent. tsconfig sets
 * "types": [] so @types/node is never pulled in globally.
 */
declare module 'child_process' {
  export interface ExecOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
  }

  export type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

  export function exec(command: string, options: ExecOptions, callback: ExecCallback): void;
}

declare const process: {
  env: Record<string, string | undefined>;
};
