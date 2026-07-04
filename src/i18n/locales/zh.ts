export default {
  // 同步消息
  'sync.completed': '同步完成：拉取 {pulled}，推送 {pushed}，删除 {deleted}',
  'sync.completed.withConflicts': '同步完成：拉取 {pulled}，推送 {pushed}，删除 {deleted}，冲突 {conflicts}',
  'sync.completed.withErrors': '同步完成：拉取 {pulled}，推送 {pushed}，删除 {deleted}，错误 {errors}',
  'sync.failed': '同步失败：{message}',
  'sync.skipped.offline': '离线。网络恢复后将继续同步。',
  'sync.skipped.noRemote': '请在设置中配置远程仓库。',
  'sync.skipped.backendNotAvailable': '{backend} 后端不可用。请检查设置。',
  'sync.skipped.backendNotInitialized': '后端未初始化。请检查设置。',
  'sync.skipped.cannotReach': '无法连接远程。请检查网络连接。',
  'sync.skipped.emptyRemote': '远程返回空文件列表。跳过同步以防止数据丢失。',
  'sync.skipped.resolvingConflicts': '同步跳过：正在解决冲突',

  // 冲突消息
  'conflict.detected': '检测到 {count} 个冲突',
  'conflict.resolved': '已解决 {path}：{resolution}',
  'conflict.allResolved': '所有冲突已解决',
  'conflict.rebaseInProgress': 'Git rebase 进行中。请手动解决：git rebase --abort 或 git rebase --continue',
  'conflict.mergeInProgress': 'Git merge 进行中。请解决冲突后运行：git merge --continue',
  'conflict.cherryPickInProgress': 'Git cherry-pick 进行中。请手动解决。',

  // 文件操作
  'file.downloaded': '已下载：{path}',
  'file.uploaded': '已上传：{path}',
  'file.deletedRemote': '已从远程删除：{path}',
  'file.deletedLocal': '已从本地删除：{path}',
  'file.skippedLarge': '跳过大文件：{path}（{size}）',
  'file.conflict': '冲突（内容不同）：{path}',
  'file.sameContent': '双方内容相同：{path}',
  'file.remoteChanged': '远程已更改，正在拉取：{path}',
  'file.localChanged': '本地已更改，正在推送：{path}',
  'file.bothChanged': '双方都已更改，冲突：{path}',
  'file.firstSync': '首次同步，使用远程版本：{path}',
  'file.noBaseline': '无基线，推送本地：{path}',

  // 设置
  'settings.exported': '设置已导出到 .obsidian/plugins/hybrid-git-sync/settings-export.json',
  'settings.imported': '设置导入成功',
  'settings.importFailed': '设置导入失败',
  'settings.syncStateCleared': '同步状态已清除',

  // 通知
  'notice.syncCompleted': '同步完成',
  'notice.pullCompleted': '拉取完成',
  'notice.pushCompleted': '推送完成',
  'notice.offline': '离线',
  'notice.autoSyncEnabled': '自动同步已开启',
  'notice.autoSyncDisabled': '自动同步已关闭',
  'notice.initFailed': '同步后端初始化失败。请检查设置。',
  'notice.gitNotAvailable': '移动端不支持 Git 后端，使用 API 后端。',
  'notice.gitignoreCreated': '已创建 .gitignore 默认规则',
  'notice.conflictsResolved': '所有冲突已解决',
  'notice.conflictResolved': '已解决 {path}：{resolution}',
  'notice.logsCopied': '日志已复制到剪贴板',
  'notice.settingsExported': '设置已导出到 .obsidian/plugins/hybrid-git-sync/settings-export.json',
  'notice.settingsImported': '设置导入成功',
  'notice.settingsImportFailed': '设置导入失败',
  'notice.syncStateCleared': '同步状态已清除',
  'notice.noActiveFile': '没有活动文件',
  'notice.restoreApiOnly': '恢复功能仅在 API 模式下可用',
  'notice.fileNotFound': '远程未找到文件',
  'notice.fileRestored': '已从远程恢复 {path}',
  'notice.pullFailed': '拉取失败：{message}',
  'notice.pushFailed': '推送失败：{message}',
  'notice.syncError': '同步错误：{message}',
  'notice.autoSyncToggled': '自动同步已{status}',

  // 界面
  'ui.history': '提交历史',
  'ui.changes': '变更',
  'ui.diff': '文件差异',
  'ui.resolveConflict': '解决冲突',
  'ui.keepLocal': '保留本地',
  'ui.keepRemote': '保留远程',
  'ui.saveBoth': '保存两者',
  'ui.skip': '跳过',
  'ui.processing': '处理中...',
  'ui.noChanges': '无变更',
  'ui.noCommits': '无提交记录',
  'ui.noDifferences': '无差异',

  // 状态栏
  'status.ready': '就绪',
  'status.syncing': '同步中...',
  'status.synced': '已同步 {time}',
  'status.failed': '同步失败',
  'status.conflicts': '检测到冲突',
  'status.offline': '离线',

  // 时间
  'time.justNow': '刚刚',
  'time.minutesAgo': '{count}分钟前',
  'time.hoursAgo': '{count}小时前',
  'time.daysAgo': '{count}天前',

  // .gitignore 注释
  'gitignore.obsidianDeviceFiles': 'Obsidian - 设备相关文件',
  'gitignore.pluginsDirectory': '插件目录（代码、配置、依赖全部忽略）',
  'gitignore.cache': '缓存',
  'gitignore.trash': '回收站',
  'gitignore.osFiles': '操作系统文件',
  'gitignore.tempFiles': '临时文件',

  // 日志前缀
  'log.syncState': '[同步状态]',
  'log.plugin': '[混合Git同步]',
};
