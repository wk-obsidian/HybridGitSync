import { t } from '../i18n';

/**
 * .gitignore pattern parser and matcher
 */
export class GitignoreRules {
  private patterns: GitignorePattern[] = [];
  private builtInPatterns: string[] = [
    '.obsidian/',
    '.trash/',
    '.git/',
    '.DS_Store',
    'Thumbs.db',
    '*.tmp',
    '*.bak',
  ];

  constructor() {
    // Built-in patterns are only used as fallback when no .gitignore exists
  }

  /**
   * Parse and add patterns from .gitignore content
   */
  addRules(content: string): void {
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        this.addPattern(trimmed);
      }
    }
  }

  /**
   * Use built-in patterns as fallback
   */
  useBuiltInPatterns(): void {
    this.builtInPatterns.forEach(p => this.addPattern(p));
  }

  /**
   * Get default .gitignore content with localized comments
   */
  getDefaultContent(): string {
    return `# ${t('gitignore.obsidianDeviceFiles')}
.obsidian/workspace.json
.obsidian/workspace-mobile.json

# ${t('gitignore.pluginsDirectory')}
.obsidian/plugins/

# ${t('gitignore.cache')}
.obsidian/cache/

# ${t('gitignore.trash')}
.trash/

# ${t('gitignore.osFiles')}
.DS_Store
Thumbs.db

# ${t('gitignore.tempFiles')}
*.tmp
*.bak
`;
  }

  /**
   * Add a single pattern
   */
  private addPattern(pattern: string): void {
    let negate = false;
    let cleanPattern = pattern;

    // Handle negation
    if (cleanPattern.startsWith('!')) {
      negate = true;
      cleanPattern = cleanPattern.substring(1);
    }

    // Convert gitignore pattern to regex
    const regex = this.patternToRegex(cleanPattern);
    this.patterns.push({ pattern: cleanPattern, regex, negate });
  }

  /**
   * Check if a path should be ignored
   */
  shouldIgnore(path: string): boolean {
    let ignored = false;

    for (const p of this.patterns) {
      if (p.regex.test(path)) {
        ignored = !p.negate;
      }
    }

    return ignored;
  }

  /**
   * Filter a list of paths, removing ignored ones
   */
  filter(paths: string[]): string[] {
    return paths.filter(p => !this.shouldIgnore(p));
  }

  /**
   * Convert gitignore pattern to RegExp
   */
  private patternToRegex(pattern: string): RegExp {
    let regexStr = '^';
    let i = 0;

    // Handle directory-only patterns (ending with /)
    const dirOnly = pattern.endsWith('/');
    if (dirOnly) {
      pattern = pattern.slice(0, -1);
    }

    while (i < pattern.length) {
      const char = pattern[i];

      if (char === '*') {
        if (pattern[i + 1] === '*') {
          // ** matches any number of directories
          if (pattern[i + 2] === '/') {
            regexStr += '(.*/)?';
            i += 3;
          } else {
            regexStr += '.*';
            i += 2;
          }
        } else {
          // * matches anything except /
          regexStr += '[^/]*';
          i++;
        }
      } else if (char === '?') {
        // ? matches any single character except /
        regexStr += '[^/]';
        i++;
      } else if (char === '[') {
        // Character class
        const end = pattern.indexOf(']', i + 1);
        if (end > -1) {
          regexStr += pattern.substring(i, end + 1);
          i = end + 1;
        } else {
          regexStr += '\\[';
          i++;
        }
      } else {
        // Escape special regex characters
        if (/[.+^${}()|\\]/.test(char)) {
          regexStr += '\\';
        }
        regexStr += char;
        i++;
      }
    }

    if (dirOnly) {
      regexStr += '(/.*)?$';
    } else {
      regexStr += '(/.*)?$';
    }

    return new RegExp(regexStr);
  }
}

interface GitignorePattern {
  pattern: string;
  regex: RegExp;
  negate: boolean;
}
