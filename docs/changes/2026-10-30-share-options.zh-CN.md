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

不改二维码下载、笔记本分享、认证设计、备份/同步、无关分享重构、发版/版本号/部署，也不删除用户数据。不修改用户当前有未提交导入改动的工作区。不自动提交、合并或部署 PR。

最坏后果是密码更新导致分享无法解锁，或公开页错误隐藏元数据/内容。回退是撤回应用代码，保留追加 migration；已有分享仍可读。migration 和旧客户端行为需要明确验证。真实 Cloudflare/Docker 生产及已安装桌面端验收不在本地变更范围，除非另行要求。

## 完成核对

实现与本地验收已完成，位于 `codex/issue-714-share-options`。未执行生产部署。

- 自定义密码已接通 schema、client、分享 API 和 Web 对话框；保留原生成、加密、管理端读取和复制路径。详情开关通过新增 `0082_memo_share_options.sql`、API 映射和公开页展示实现；五个语言目录同步更新。
- 密码开关/重新生成使用原有 mutation 错误处理，自定义保存失败时保留输入；保存期间输入不可编辑。已用注入 503 和延迟响应复现并验证修复，未处理 Promise 错误为零。关闭保护时忽略随附有效密码，撤回组合拒绝条件；移除仅匹配源码字符串的公开页测试，以实际页面验收为准。
- [浏览器回归脚本](evidence/2026-10-30-share-options/password-controls-regression.mjs)与[结果](evidence/2026-10-30-share-options/password-controls-regression.json)覆盖开关、重新生成和自定义保存失败，以及处理中状态。已检查 [保存中](evidence/2026-10-30-share-options/review-pending.png) / [保存后](evidence/2026-10-30-share-options/review-saved.png) 的实际渲染。完整分享流程及详情开关的有效证据保留在 [browser.json](evidence/2026-10-30-share-options/browser.json)。
- 当前 31 项分享 API/Web 测试、`bun run typecheck`、`bun run typecheck:mobile`、`bun run build:web` 和 `git diff --check` 均通过，见 [validation.json](evidence/2026-10-30-share-options/validation.json)。复用行为未变的 41 项 shared sharing、share-page、notebook-share 测试结果，见 [related-tests.txt](evidence/2026-10-30-share-options/related-tests.txt)。
- [跨版本脚本](evidence/2026-10-30-share-options/cross-version.mjs)从基线 `e052ac3b` 加载旧分享路由与旧 schema，在真实内存 SQLite 的旧结构上创建并解锁分享，再执行 migration 0082、切换新路由，最后用旧路由读取/更新新数据。[结果](evidence/2026-10-30-share-options/cross-version.json)覆盖旧行逐字段保留、升级后旧解锁有效、换密码使旧密码/Cookie 对正文和附件失效、旧客户端生成/关闭密码仍可用。脚本使用当前未变更的依赖模块及测试对象存储，不是已安装应用升级测试。

双向核对：两项功能、失败处理及兼容性均有实现与验收证据；实际产品 diff 对应密码、详情字段/开关、类型和翻译。笔记本路由仅补充 `showDetails: true`，保持原展示。二维码、认证机制、版本和部署配置未改。

未验证：已安装原生桌面端及真实 Cloudflare/Docker 生产环境；此次没有移动端功能变更或 Android 真机验收。发布时先应用新增 migration，再部署新版应用。回退可保留新增字段并撤回应用代码，已验证旧分享路由仍可读取和更新。
