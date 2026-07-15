# Hybrid Git Sync

[English](README.md)

跨平台 Obsidian Git 同步插件。桌面端使用原生 Git，移动端使用 GitHub API。

## 功能特性

- **原生 + API 混合模式** — 桌面端支持本地 Git 和 API 两种方式，移动端使用 GitHub API 突破文件系统限制
- **全平台一致性** — Windows、macOS、Android、iOS 体验统一
- **自动 / 增量同步** — 定时或修改后自动推送，支持智能冲突解决
- **灵活认证** — GitHub OAuth（一键授权）或 Personal Access Token

### 用户界面
- 状态栏显示同步状态
- Ribbon 图标快速操作
- 提交历史视图
- Diff 视图（逐行对比）
- 变更文件面板
- 冲突解决弹窗

### 工具功能
- 设置导入导出
- 日志查看与导出
- 同步状态管理
- 网络状态检测
- 离线队列

## 安装

### 从社区插件安装
1. 打开 Settings → Community Plugins
2. 搜索 "Hybrid Git Sync"
3. 安装并启用

### 手动安装
1. 下载最新版本
2. 解压到 `.obsidian/plugins/hybrid-git-sync/`
3. 在 Settings → Community Plugins 中启用

## 快速开始

### GitHub（推荐）

1. 打开插件设置
2. 点击 **连接** 按钮，授权 GitHub
3. 从下拉列表选择仓库
4. 完成！插件会自动同步

### Git 模式（桌面端）

1. 确保系统已安装 Git
2. 在 vault 目录初始化 Git：`git init`
3. 配置远程仓库：`git remote add origin <url>`
4. 插件会自动使用系统 Git

### API 模式（移动端）

1. 在 GitHub 创建仓库
2. 生成 Personal Access Token（需要 `repo` 权限）
3. 在插件设置中配置：
   - API 提供商：GitHub
   - API Token：你的 Token
   - 远程 URL：`用户名/仓库名`

## 后端模式

| 模式 | 说明 | 使用场景 |
|---|---|---|
| 自动（推荐） | 根据 Git 可用性自动检测 | 默认 |
| Git | 使用系统 Git | 桌面端已安装 Git |
| API | 使用 GitHub/GitLab/Gitea API | 移动端或无 Git |

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
| View logs | 查看日志（复制到剪贴板） |
| Export settings | 导出设置 |
| Import settings | 导入设置 |
| Clear sync state | 清除同步状态 |

## 忽略规则

插件会自动读取 `.gitignore` 文件。如果没有，会自动创建一个包含以下规则：

```gitignore
# Obsidian - 设备相关文件
.obsidian/workspace.json
.obsidian/workspace-mobile.json

# 插件目录（代码、配置、依赖全部忽略）
.obsidian/plugins/

# 缓存
.obsidian/cache/

# 回收站
.trash/

# 操作系统文件
.DS_Store
Thumbs.db

# 临时文件
*.tmp
*.bak
*.swp
*~
```

## 已知限制

- API 模式不支持 SSH 认证
- API 模式单文件限制 50MB
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
