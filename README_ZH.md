# Hybrid Git Sync

[English](README.md)

跨平台 Obsidian Git 同步插件。桌面端使用原生 Git，移动端使用 GitHub API。

## 功能特性

### 核心同步
- ✅ 双向同步（推送/拉取）
- ✅ 增量同步（只传输变化的文件）
- ✅ 并行传输（最多 3 个并发）
- ✅ 自动同步（定时/文件变更触发）
- ✅ 冲突检测与解决
- ✅ .gitignore 支持

### 平台支持
- ✅ Windows / macOS / Linux（Git 模式）
- ✅ Android / iOS（API 模式）
- ✅ 自动检测平台并选择后端

### 用户界面
- ✅ 状态栏显示同步状态
- ✅ Ribbon 图标快速操作
- ✅ 提交历史视图
- ✅ Diff 视图
- ✅ 变更文件面板
- ✅ 冲突解决弹窗

### 工具功能
- ✅ 设置导入导出
- ✅ 日志查看与导出
- ✅ 同步状态清除
- ✅ 网络状态感知
- ✅ 离线队列

## 安装

1. 下载 `main.js` 和 `manifest.json`
2. 放入 `.obsidian/plugins/hybrid-git-sync/`
3. 在 Obsidian 中启用插件

## 配置

### API 模式（移动端）

1. 在 GitHub 创建仓库
2. 生成 Personal Access Token（需要 `repo` 权限）
3. 在插件设置中配置：
   - Remote URL: `用户名/仓库名`
   - API Token: 你的 Token
   - Branch: `main`

### Git 模式（桌面端）

1. 确保系统已安装 Git
2. 在 vault 目录初始化 Git 仓库：`git init`
3. 配置远程仓库：`git remote add origin <url>`
4. 插件会自动使用系统 Git

## 命令

| 命令 | 说明 |
|---|---|
| Sync now | 立即同步 |
| Pull | 仅拉取 |
| Push | 仅推送 |
| View sync status | 查看同步状态 |
| View commit history | 查看提交历史 |
| View changes | 查看变更文件 |
| Diff current file | 对比当前文件 |
| Restore file from remote | 从远程恢复文件 |
| Switch branch | 查看/切换分支 |
| Toggle auto sync | 开关自动同步 |
| View logs | 查看日志 |
| Export settings | 导出设置 |
| Import settings | 导入设置 |
| Clear sync state | 清除同步状态 |

## 忽略规则

插件会自动读取 `.gitignore` 文件。如果没有，会自动创建一个包含以下规则：

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

## 已知限制

- API 模式不支持 SSH 认证
- API 模式单文件限制 100MB
- 移动端无法后台持续同步
- GitLab/Gitea 支持计划中

## 开发

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build
```

## 许可证

MIT
