# 分享选项：自定义密码与页面详情

[English](2026-10-30-share-options.md) · [Issue #714](https://github.com/tianma-if/edgeever/issues/714)

## 问题与目标

完成 #714 剩余两项用户功能：分享者可以自行设置访问密码，也可以隐藏公开页面中的 EdgeEver/只读分享页头和更新时间详情。已有分享保持当前行为。二维码 PNG/SVG 下载已经发布，不属于本次改动。

## 允许变更与验收

1. **自定义密码。** 扩展现有单笔记分享 PATCH 契约，在保留自动生成密码流程的同时允许密码保护分享接收显式密码。保留只发送 `passwordProtected` 的旧客户端、哈希/静态加密、解锁限流、Cookie 失效和密码返回行为。显式密码先去除首尾空白，长度必须为4–64个字符；空值、过短、过长或只含空白的输入拒绝且不修改分享。对话框提供自动生成/自定义两种模式，自定义输入只在编辑/创建期间显示，并保留现有管理端密码读取、重新生成和复制行为。保留 `passwordProtected: false` 的关闭语义，不因随附有效密码增加组合拒绝条件。保存期间禁用自定义密码输入，失败时保留输入和原分享状态、显示现有错误，不产生未处理的 Promise。测试 API 兼容、校验、哈希、替换、旧客户端以及保存失败/处理中状态。
2. **分享详情开关。** 增加可加性字段，空值/默认值保持现有公开页详情可见。分享者可以按单笔记分享关闭详情。公开 HTML 页面和客户端渲染在关闭时只移除 EdgeEver/只读分享页头和更新时间详情；笔记内容、标题/元数据、Markdown 接口、资源、密码门禁、slug/token 和笔记本分享不变。测试旧数据、开关两种状态以及密码保护/公开渲染。
3. 更新共享 schema/类型、API 行映射、migration、Web/桌面分享对话框、公开分享展示及涉及的语言目录。复用现有分享组件、Tooltip 和 API 错误模式。migration 只追加字段，并在现有分享契约允许范围内兼容旧版本应用。

验收：在实现前后补齐针对性 API/分享页/对话框测试；执行相关 API、shared、Web 测试，以及 `bun run typecheck`、`bun run typecheck:mobile`、`bun run build:web`。在隔离本地实例中实际操作分享对话框和公开页，覆盖旧分享行、自动/自定义密码、无效密码、密码替换、详情开关两种状态、Markdown/资源路径。记录真实失败及未验证的原生/生产路径。

## 边界与风险

不改二维码下载、笔记本分享、认证设计、备份/同步、无关分享重构、发版/版本号/部署，也不删除用户数据。

最坏后果是密码更新导致分享无法解锁，或公开页错误隐藏元数据/内容。回退是撤回应用代码，保留追加 migration；已有分享仍可读。migration 和旧客户端行为需要明确验证。真实 Cloudflare/Docker 生产及已安装桌面端验收不在本地变更范围，除非另行要求。

## 完成核对

两项功能均已实现。自定义密码沿用现有加密、限流和解锁失效机制；详情字段通过 `0082_memo_share_options.sql` 增加，默认显示。笔记本页面保持原展示，二维码和部署配置未改。

- 分享 API/Web 测试 31 项通过；分享菜单测试 4 项通过；类型检查、移动端类型检查、Web 构建及 diff 检查通过，见 [验证结果](evidence/2026-10-30-share-options/validation.json) 和 [菜单测试](evidence/2026-10-30-share-options/menu-tests.txt)。行为未变的 41 项关联测试结果仍有效。
- 已实际验证密码设置/替换/关闭、公开页详情开关、Markdown 访问，以及失败时保留原状态和输入、保存期间禁用输入。见 [浏览器验收](evidence/2026-10-30-share-options/browser.json)、[失败和处理中状态回归](evidence/2026-10-30-share-options/password-controls-regression.mjs) 与[结果](evidence/2026-10-30-share-options/password-controls-regression.json)。真实截图：[保存中](evidence/2026-10-30-share-options/review-pending.png)、[保存后](evidence/2026-10-30-share-options/review-saved.png)、[页头显示](evidence/2026-10-30-share-options/details-visible.png)、[页头隐藏](evidence/2026-10-30-share-options/details-hidden.png)。
- [跨版本验收](evidence/2026-10-30-share-options/cross-version.mjs)覆盖基线 `e052ac3b` 分享路由/schema → SQLite migration 0082 → 新路由 → 旧路由读取和更新。结果验证旧行保留、升级后旧解锁有效、换密码使旧密码/Cookie 对正文和附件失效。使用测试对象存储，属于 API/数据库兼容验证，不是已安装应用升级测试。

全量 Ubuntu 回归尚未通过：上游已有的 `PreferenceCard.test.mjs:31` 字体断言与上游等宽代码字体支持冲突。由上游字体变更维护者同步该测试后重新运行 CI；本变更不修改字体实现或该测试。

未验证已安装原生桌面端及真实 Cloudflare/Docker 生产环境；没有移动端功能变更。部署时先应用新增 migration，再部署应用。回退可保留新增字段并撤回应用代码；旧分享路由读取和更新已验证。
