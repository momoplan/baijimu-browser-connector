# 百积木浏览器连接器

浏览器连接器让百积木 Bridge Agent 在用户明确授权的 origin 范围内操作本机 Chrome、Edge 或 Chromium。首发版本为 `0.1.0`，要求百积木客户端 `0.6.0` 或更高版本。

## 身份与安装

应用身份只能由本地应用市场服务注册后分配。仓库中的 `connector.template.json` 不是可安装清单；在服务端注册完成前，仓库不会生成 `connector.json`，也不会伪造 appId。

注册流程：

1. 使用新版 `baijimu local-app create --data @release/registration.json` 向平台建档并保存原始 JSON 响应。
2. 执行 `npm run record-registration -- <server-response.json>`。脚本只接受服务端 UUID，并生成 `release/local-app.json` 与 `connector.json`。
3. 后续构建执行 `npm run materialize-manifest`，确认模板、目录和服务端 appId 一致。
4. 发布制品后使用 `baijimu local-app publish <appId> ...` 登记精确版本、revision、HTTPS 制品地址与 SHA-256。GitHub 直接安装也必须先完成这一步；审核仅决定公开市场展示。

## 本地状态

- 浏览器 profile：`$BAIJIMU_LOCAL_APP_DATA_DIR/browser-profile`
- origin 授权和浏览器选项：`$BAIJIMU_LOCAL_APP_DATA_DIR/authorization.json`
- 私有调用凭证：由 Bridge Agent 生成并通过 `BAIJIMU_LOCAL_APP_TOKEN_FILE` 注入

升级会保留整个应用私有数据目录，因此登录 Cookie、授权配置和浏览器选项都会保留。卸载时是否删除数据由客户端向用户单独确认。

## 安全边界

- 服务只监听 `127.0.0.1`，健康检查、管理接口和所有远程能力均要求 Bridge 按 appId 生成的 Bearer token。
- HTTP 只允许 loopback origin；其他网站必须使用 HTTPS。
- 授权项是精确 origin，不接受通配符、路径、查询参数或 URL 凭证。
- 顶层页面导航在 Playwright 网络路由层校验；越过白名单的跳转会在请求发出前阻止。
- 修改授权前先关闭浏览器上下文，避免已经打开的页面继续持有被撤销权限。
- profile 和授权文件只写入应用私有数据目录，不写安装目录，也不上传平台。

## 开发验证

```bash
npm ci
npm test
```

本地手工运行也必须提供 `BAIJIMU_LOCAL_APP_ID`、绝对的 `BAIJIMU_LOCAL_APP_DATA_DIR`、`BAIJIMU_LOCAL_APP_TOKEN_FILE` 和 `BAIJIMU_BROWSER_CONNECTOR_PORT`。正式运行由 Bridge Agent 注入这些值。
