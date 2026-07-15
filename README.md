# Hybrid Git Sync

[中文文档](README_ZH.md)

A cross-platform Git sync plugin for Obsidian. Uses native Git on desktop and GitHub API on mobile.

## Features

- **Native + API Hybrid Mode** — Desktop supports both local Git and GitHub API; mobile uses GitHub API to bypass filesystem limits
- **Cross-Platform Consistency** — Unified experience on Windows, macOS, Android, and iOS
- **Auto / Incremental Sync** — Scheduled or on-change auto-push with smart conflict resolution
- **Flexible Authentication** — GitHub OAuth (one-click) or Personal Access Token

### User Interface
- Status bar with sync state
- Ribbon icons for quick access
- Commit history view
- Diff view with line-by-line comparison
- Changed files panel
- Conflict resolution modal

### Utilities
- Settings import/export
- Log viewer and export
- Sync state management
- Network status detection
- Offline queue

## Installation

### From Community Plugins
1. Open Settings → Community Plugins
2. Search for "Hybrid Git Sync"
3. Install and enable

### Manual
1. Download the latest release
2. Extract to `.obsidian/plugins/hybrid-git-sync/`
3. Enable the plugin in Settings → Community Plugins

## Quick Start

### GitHub (Recommended)

1. Open plugin settings
2. Click **Connect** to authorize with GitHub
3. Select a repository from the dropdown
4. Done! The plugin will auto-sync

### Git Mode (Desktop)

1. Ensure Git is installed on your system
2. Initialize Git in vault directory: `git init`
3. Configure remote: `git remote add origin <url>`
4. The plugin will automatically use system Git

### API Mode (Mobile)

1. Create a repository on GitHub
2. Generate a Personal Access Token (requires `repo` scope)
3. Configure in plugin settings:
   - API Provider: GitHub
   - API Token: your token
   - Remote URL: `username/repo`

## Backend Modes

| Mode | Description | Use Case |
|---|---|---|
| Auto (recommended) | Auto-detect based on Git availability | Default |
| Git | Use system Git | Desktop with Git installed |
| API | Use GitHub/GitLab/Gitea API | Mobile or no Git |

## Commands

| Command | Description |
|---|---|
| Sync now | Sync immediately |
| Pull | Pull only |
| Push | Push only |
| View sync status | View sync status |
| View commit history | View commit history |
| View changes | View changed files |
| Diff current file | Diff current file |
| Restore file from remote | Restore file from remote |
| Switch branch | View/switch branch |
| Toggle auto sync | Toggle auto sync |
| View logs | View logs (copy to clipboard) |
| Export settings | Export settings |
| Import settings | Import settings |
| Clear sync state | Clear sync state |

## Ignore Rules

The plugin automatically reads `.gitignore` file. If none exists, it creates one with these rules:

```gitignore
# Obsidian - Device-specific files
.obsidian/workspace.json
.obsidian/workspace-mobile.json

# Plugins directory (code, config, dependencies)
.obsidian/plugins/

# Cache
.obsidian/cache/

# Trash
.trash/

# OS files
.DS_Store
Thumbs.db

# Temp files
*.tmp
*.bak
*.swp
*~
```

## Known Limitations

- API mode does not support SSH authentication
- API mode single file limit is 50MB
- Mobile cannot run continuous background sync
- GitLab/Gitea support planned for future release

## Development

```bash
# Install dependencies
npm install

# Development mode
npm run dev

# Build
npm run build
```

## License


## ☕ Support

If you find this plugin useful and would like to support its development, you can support me on Ko-fi.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/walkskyer)
