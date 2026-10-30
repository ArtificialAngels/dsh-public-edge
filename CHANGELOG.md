# Changelog

## 0.2.0 (2026-10-30)

- 首个公开发布版本。
- 设置页「公网访问」面板：启动 / 停止 / 换地址 / 复制链接 / 二维码 / 状态刷新。
- 内置局域网桥（`0.0.0.0:8787` → DSH 本机端口，Host 改写、剥 `Origin`/`Sec-Fetch-*`、WebSocket 透传）。
- `cloudflared` 自动下载到 `~/.dsh/dsh-public-edge/`，支持 Windows/macOS/Linux；GitHub 直连失败时按 `downloadMirrors` 走镜像。
- 默认配置不再写死任何本机路径。
- 安全加固：`/pair` 只在本机回环端口（`127.0.0.1:8788`），桥与隧道对 `/pair` 一律 404；隧道响应自动补 `Secure` cookie 与 HSTS；控制在 DSH 已鉴权的 `/api` 通道上注册（仅 owner 可调）。
- 标准插件元数据（displayName / keywords / repository / engines）。

## 0.1.2 (2026-10-30，内部版本)

- 修复：公网可经 `/pair` 读到带 token 的链接。
- 隧道响应 cookie 补 `Secure`、回 HSTS。

## 0.1.0 (2026-10-30，内部版本)

- 原型：桥 + cloudflared 隧道 + 设置面板。
