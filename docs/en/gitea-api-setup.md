# Gitea API Mode Configuration

This guide explains how to configure Hybrid Git Sync to sync your Obsidian vault using Gitea's REST API.

## Prerequisites

- A Gitea account (self-hosted or [gitea.com](https://gitea.com))
- An existing Git repository on Gitea for your vault
- A Personal Access Token with `repo` permissions

## Step 1: Create a Personal Access Token

1. Log in to your Gitea instance
2. Go to **Settings** → **Applications** → **Personal Access Tokens**
3. Click **Generate New Token**
4. Give it a descriptive name (e.g., "Obsidian Sync")
5. Select the **repo** scope (full control of repositories)
6. Click **Generate Token**
7. **Copy the token immediately** — you won't see it again

## Step 2: Configure the Plugin

Open Obsidian → Settings → Hybrid Git Sync and configure:

| Setting | Value | Example |
|---|---|---|
| Backend Mode | API | — |
| API Provider | Gitea | — |
| Custom API URL | Your Gitea API endpoint | `https://gitea.com/api/v1` |
| API Token | Your Personal Access Token | `abc123...` |
| Remote Repository | `username/repo` | `walkskyer/my-vault` |
| Branch | Sync branch | `main` |

### API URL Format

The API URL must include `/api/v1` at the end:

| Gitea Instance | API URL |
|---|---|
| gitea.com | `https://gitea.com/api/v1` |
| Self-hosted | `https://your-domain.com/api/v1` |

**Important:** Do not add a trailing slash.

## Step 3: Test the Connection

1. After configuring, the plugin will automatically check if the repository is accessible
2. If successful, you'll see the sync status in the status bar
3. Click **Sync Now** to perform your first sync

## Troubleshooting

### "API backend is not available"

- Verify your API URL is correct (must end with `/api/v1`)
- Check that your token is valid and not expired
- Ensure the repository exists and is accessible with your token
- Enable **Debug Mode** in Advanced settings to see detailed logs

### "Cannot reach remote"

- Check your network connection
- Verify the Gitea instance is accessible from your device
- For self-hosted instances, ensure the server is running

### Sync fails silently

- Enable **Debug Mode** in Advanced settings
- Check the console logs for error messages
- Verify the repository format is `username/repo` (no leading slash)

## Notes

- **No OAuth support**: Gitea OAuth requires per-instance configuration, so only Personal Access Token authentication is supported
- **Self-hosted instances**: The Custom API URL is required for self-hosted Gitea instances
- **File size limit**: Depends on your Gitea instance configuration (default may vary)
