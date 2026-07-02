# Hybrid Git Sync

[中文文档](README_ZH.md)

A cross-platform Git sync plugin for Obsidian. Uses native Git on desktop and GitHub API on mobile.

## Features

### Core Sync
- ✅ Bidirectional sync (push/pull)
- ✅ Incremental sync (only transfer changed files)
- ✅ Parallel transfer (up to 3 concurrent)
- ✅ Auto sync (timer/file change trigger)
- ✅ Conflict detection and resolution
- ✅ .gitignore support

### Platform Support
- ✅ Windows / macOS / Linux (Git mode)
- ✅ Android / iOS (API mode)
- ✅ Auto-detect platform and select backend

### User Interface
- ✅ Status bar shows sync state
- ✅ Ribbon icons for quick access
- ✅ Commit history view
- ✅ Diff view
- ✅ Changed files panel
- ✅ Conflict resolution modal

### Utilities
- ✅ Settings import/export
- ✅ Log viewer and export
- ✅ Sync state clearing
- ✅ Network status detection
- ✅ Offline queue

## Installation

1. Download `main.js` and `manifest.json`
2. Place in `.obsidian/plugins/hybrid-git-sync/`
3. Enable the plugin in Obsidian

## Configuration

### API Mode (Mobile)

1. Create a repository on GitHub
2. Generate a Personal Access Token (requires `repo` scope)
3. Configure in plugin settings:
   - Remote URL: `username/repo`
   - API Token: your token
   - Branch: `main`

### Git Mode (Desktop)

1. Ensure Git is installed on your system
2. Initialize Git in vault directory: `git init`
3. Configure remote: `git remote add origin <url>`
4. The plugin will automatically use system Git

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
| View logs | View logs |
| Export settings | Export settings |
| Import settings | Import settings |
| Clear sync state | Clear sync state |

## Ignore Rules

The plugin automatically reads `.gitignore` file. If none exists, it creates one with these rules:

```gitignore
# Obsidian
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/plugins/*/main.js
.obsidian/plugins/*/manifest.json
.obsidian/plugins/*/styles.css
.obsidian/plugins/*/data.json

# OS
.DS_Store
Thumbs.db

# Temp
*.tmp
*.bak
```

## Known Limitations

- API mode does not support SSH authentication
- API mode single file limit is 100MB
- Mobile cannot run continuous background sync
- GitLab/Gitea support planned

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

MIT
