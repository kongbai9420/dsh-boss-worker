# DSH 兼容性检查

检查日期：2026-10-17（Asia/Shanghai）。插件版本：`0.1.0-beta.2`。

## 目标版本

官方 npm `@deepseek-ai/dsh` 的 `latest` 为 `0.2.0-rc.2`，`next` 为 `0.2.1-rc.2`。后者同日发布为 [dsh-v0.2.1-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)。同时保留原声明的 `0.1.7-rc.2`。

## 已修复的问题

1. 三个 DSH peerDependencies 原先只接受 `^0.1.7-rc.2`，拒绝 Issue #1 的 `0.2.0-rc.2`。新增两个已验证版本范围，保留宿主的检查机制。
2. 新版取消 `subagents.start`，改为 `startActivation`。适配新的请求/返回结构，使用 `delivery: 'caller'`，由任务板在保存结果后发送唯一的审查通知，保持 `review` 门禁。
3. `startActivation` 的 signal 只拥有启动阶段的取消权。发布后的中断必须转至该 activation 的 `dispose()`；适配器保留同一个释放 Promise，使释放失败仍能被宿主观察到。
4. 新请求不再接受 `persona`。成员指令随任务文本传递，旧 API 仍原样接收 `persona`。不更改用户的成员或模型路由配置。
5. Cordis 服务代理改变方法的 `this`，直接访问本服务的原生私有字段会抛错。将本 Profile 服务的方法绑定到原始实例，真实服务代理调用已验证。
6. 提示词组装通过 `context.agent.session` 提供会话；旧的 `context.session` 假设会使协作规则静默缺失。现在兼容两种上下文。
7. 新任务记录子会话地址模式 `unknown`，让新版工作台按真实子会话解析；历史任务继续按 `one-shot` 打开。新增首页 `conversation.hero.options` 入口，并读取新版 `diagnostic` 错误说明。
8. HTTP 路由使用官方声明的 `kind: 'prefix'`，修正旧代码的 `prefixes` 拼写。

官方契约参考：[子任务 API](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent/src/index.ts)、[activation 类型](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent/src/types.ts)、[提示词上下文](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/core/agent/src/dispatch.ts)、[前端插槽](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/ui-conversation/src/client/contract/slots.ts)。

## 验证方法与边界

本地验证结果（Node.js `26.7.0`）：

| DSH | 宿主服务 / HTTP / 中断释放 | 官方前端插槽契约 |
| --- | --- | --- |
| `0.1.7-rc.2` | 通过（`start`） | 通过 |
| `0.2.0-rc.2` | 通过（`start`） | 通过 |
| `0.2.1-rc.2` | 通过（`startActivation`） | 通过（含新版首页入口） |

单元/回归测试：289 项通过；独立客户端模拟通过；npm 打包白名单检查通过。CI 配置使用 Node.js 24；此处的结果来自本地执行，不代表已经运行远程 Actions。

`npm test` 运行隔离单元/回归测试；`npm run test:client` 运行客户端模拟。

`test/host-compat-smoke.mjs` 必须由普通 Node 进程执行，断言未启用测试替身。它加载隔离安装的真实 Cordis、ToolRuntime、SystemPrompt、WebServer、SubagentRuntime 和消息构造函数，验证服务代理、HTTP 访问、七个工具注册、真实工具调用、提示词组装、模型路由请求、角色指令、子任务交付进入待审查、审查通知、运行后中断及资源释放。

宿主 smoke 仅以可控的离线 provider 替代模型执行，使用临时 Profile、临时 loopback 端口和父 Agent fixture。未调用真实模型，未启动或修改桌面 DSH，也未验证所有第三方 provider。前端 smoke 使用官方 SlotCore 和对应 Conversation 发布的插槽声明，验证实际存在的入口可以注册、注入会话身份并卸载；不代替浏览器/桌面视觉测试。

CI 的 `host-compatibility` job 将依赖版本固定为三个目标版本。安装步骤和执行命令见 `.github/workflows/check.yml`。未来其他预发布版本需要单独验证。
