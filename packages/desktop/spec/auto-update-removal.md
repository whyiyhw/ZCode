# Spec: 自动更新子系统移除（社区版性能瘦身）

## 行为

- 桌面端不再存在自动更新子系统：无每小时 manifest 轮询、无启动即查、无下载/安装状态机、无更新状态窗、无强更 gate、无「检查更新」菜单/托盘/页内入口、设置页无更新相关开关。
- 社区版升级方式 = 重新安装（或用户自行替换构建产物）；版本号仍展示（About 窗）。

## 所有权

- 版本事实来源仍是 `ZCODE_VERSION`（package.json / 构建注入），与更新链路解耦后仅用于展示与协议头。
- `appShutdownPolicy` 不再有 `"update-install"` 退出原因；应用退出原因只剩用户主动退出/关窗进托盘。

## 不变量

- 桌面运行期间不得发出任何指向 release/manifest 端点的网络请求（`/api/v1/releases/electron/manifest`）。
- UI、preload、shared 契约中不得残留**应用自动更新**相关 channel、命令 ID、设置字段与 i18n key（插件商店的 `settings.plugins.*.checkForUpdates` 是插件更新语义，不在其列）。

## 失败语义

- 不存在"检查更新失败"路径；无更新错误弹窗。
- 强更不再可能：即使远端配置了 minimalVersion，客户端也不会拉取或被阻断。

## 迁移边界

- 旧 setting.json 中的 `receivePreviewUpdates`、`autoDownloadAndInstallUpdates`、`skippedElectronUpdateVersions`、`pendingPostUpdateReleaseNotes` 成为未知字段，必须被设置 schema strip（而非 reject），保证旧配置文件可继续加载。
- 旧安装曾下载的更新缓存目录成为孤儿数据，不做主动清理。
- `electron-updater` 依赖已从 `packages/desktop/package.json` 移除（lockfile 同步）。
- 已知死链留待后续清理：`packages/shared/src/forceUpdate.ts` 及 `remoteAppConfig` 的 `ForceUpdateConfig` 类型链（0 消费者，行为无影响）。
