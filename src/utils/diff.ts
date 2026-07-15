import { diffLines, Change } from 'diff';

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  unchanged: number;
}

/**
 * Compute line-level diff between two texts
 */
export function computeDiff(oldText: string, newText: string): DiffResult {
  const changes: Change[] = diffLines(oldText, newText);
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  let oldLineNum = 1;
  let newLineNum = 1;

  for (const change of changes) {
    const changeLines = change.value.split('\n');
    // Remove empty last element from split
    if (changeLines[changeLines.length - 1] === '') {
      changeLines.pop();
    }

    for (const line of changeLines) {
      if (change.added) {
        lines.push({
          type: 'added',
          content: line,
          newLineNum: newLineNum++,
        });
        added++;
      } else if (change.removed) {
        lines.push({
          type: 'removed',
          content: line,
          oldLineNum: oldLineNum++,
        });
        removed++;
      } else {
        lines.push({
          type: 'unchanged',
          content: line,
          oldLineNum: oldLineNum++,
          newLineNum: newLineNum++,
        });
        unchanged++;
      }
    }
  }

  return { lines, added, removed, unchanged };
}

/**
 * Merge two texts with conflict markers (Git-style)
 * Uses diff library for accurate line-level comparison
 */
export function mergeWithConflictMarkers(local: string, remote: string): string {
  const changes: Change[] = diffLines(local, remote);
  const result: string[] = [];
  let conflictLocal: string[] = [];
  let conflictRemote: string[] = [];
  let inConflict = false;

  for (const change of changes) {
    const lines = change.value.split('\n');
    // Remove empty last element from split
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }

    if (change.added) {
      // Remote has lines that local doesn't
      if (!inConflict) inConflict = true;
      conflictRemote.push(...lines);
    } else if (change.removed) {
      // Local has lines that remote doesn't
      if (!inConflict) inConflict = true;
      conflictLocal.push(...lines);
    } else {
      // Lines are the same
      if (inConflict) {
        // End of conflict section - write conflict markers
        result.push('<<<<<<< LOCAL');
        result.push(...conflictLocal);
        result.push('=======');
        result.push(...conflictRemote);
        result.push('>>>>>>> REMOTE');
        conflictLocal = [];
        conflictRemote = [];
        inConflict = false;
      }
      result.push(...lines);
    }
  }

  // Handle remaining conflict at end of file
  if (inConflict) {
    result.push('<<<<<<< LOCAL');
    result.push(...conflictLocal);
    result.push('=======');
    result.push(...conflictRemote);
    result.push('>>>>>>> REMOTE');
  }

  return result.join('\n');
}

/**
 * Check if content has conflict markers
 */
export function hasConflictMarkers(content: string): boolean {
  return content.includes('<<<<<<< LOCAL') &&
         content.includes('=======') &&
         content.includes('>>>>>>> REMOTE');
}

/**
 * Merge two texts without conflict markers
 * Simply combines both versions, keeping all content
 */
export function mergeWithoutMarkers(local: string, remote: string): string {
  const changes: Change[] = diffLines(local, remote);
  const result: string[] = [];

  for (const change of changes) {
    const lines = change.value.split('\n');
    // Remove empty last element from split
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }

    if (change.added) {
      // Remote has lines that local doesn't - add them
      result.push(...lines);
    } else if (change.removed) {
      // Local has lines that remote doesn't - keep them
      result.push(...lines);
    } else {
      // Lines are the same - keep them
      result.push(...lines);
    }
  }

  return result.join('\n');
}

/**
 * Remove conflict markers and return resolved content
 * This is a simple implementation - in practice, users would edit manually
 */
export function removeConflictMarkers(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inConflict = false;
  let useLocal = true; // Default to local

  for (const line of lines) {
    if (line.startsWith('<<<<<<< LOCAL')) {
      inConflict = true;
      continue;
    }
    if (line.startsWith('=======')) {
      useLocal = false;
      continue;
    }
    if (line.startsWith('>>>>>>> REMOTE')) {
      inConflict = false;
      useLocal = true;
      continue;
    }

    if (!inConflict || useLocal) {
      result.push(line);
    }
  }

  return result.join('\n');
}
