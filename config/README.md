# 内置默认配置

`config/default.json` 是随客户端发布的默认配置，必须保留（当前为空对象）。Desktop 从打包文件读取，
Web 在构建时导入。

## 历史消费者（均已下线）

- `feedback_url` / `feedback_use_external_form`：「问题上报 / 给产品提需求」反馈功能已下线
  （2026-09-23，见 PRIVACY-AUDIT.md §十三）。
- `community_urls`：「用户社群」入口已下线（2026-09-23，见 PRIVACY-AUDIT.md §十四），
  `/api/v1/client/configs` 的 helpConfig 拉取链（`shared/helpAppConfig.ts`、
  `desktop/src/main/desktopHelpConfig.ts`、`web/src/communityUrl.ts`）随之整链移除；
  远端仍返回这些字段时会被忽略。`/api/v1/client/configs` 端点本身仍被
  coding-plan 订阅与内置 provider 下载链使用，不受影响。
