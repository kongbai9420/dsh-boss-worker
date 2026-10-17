# 更新记录 / Changelog

## v0.1.0-beta.2 — 2026-10-17

修复 [Issue #1：未与最新版 dsh 兼容](https://github.com/kongbai9420/dsh-boss-worker/issues/1)。

- 支持 DSH `0.2.0-rc.2`（npm latest）和 `0.2.1-rc.2`（next），保留 `0.1.7-rc.2`。
- 适配新版 `startActivation`，正确转发启动后的取消信号并等待释放，避免重复派发和重复审查通知。
- 修复真实 Cordis 服务代理访问原生私有字段时报错，以及新版提示词上下文导致协作规则缺失。
- 保留成员指令和 Provider/Model 路由；新版成员指令随任务文本传递，旧版仍使用 `persona`。
- 适配新版首页入口、子会话地址模式和失败诊断；修正 HTTP 路由类型声明。
- 更新中英文 README 和兼容性记录，新增三个 DSH 版本的官方宿主服务及前端插槽 CI 检查。

验证：289 项回归测试、客户端模拟，以及三个版本的官方宿主服务和前端插槽离线检查均在本地通过。宿主检查涵盖 HTTP、工具、提示词、派发、待审查通知、中断与释放；使用临时 Profile 和可控离线执行后端，未调用真实模型或验收桌面视觉效果。

安装包：Release 附件 `dsh-boss-worker-0.1.0-beta.2.tgz`。这是预发布版本，完整变更与验证边界见 [COMPATIBILITY.md](COMPATIBILITY.md)。

### English

Adds DSH `0.2.0-rc.2` and `0.2.1-rc.2` compatibility while retaining `0.1.7-rc.2`. Adapts managed child activations and cancellation, fixes Cordis proxy/private-field access and prompt assembly context, and updates client entry points and child navigation. Adds a three-version official-host compatibility CI matrix.

Validation: 289 regression tests, client simulation, and offline official-host/client-contract checks passed locally. Real model calls and desktop visual acceptance are outside this validation. Download the `.tgz` attachment from the prerelease.
