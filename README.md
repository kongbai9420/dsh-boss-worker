# dsh-boss-worker

[English](README.en.md) · [简体中文](README.md)

面向大型复杂工程项目的 DeepSeek Harness (DSH) 多模型主从协同插件：**主控架构统筹，子模型并行执行，闭环严苛验收**。

> **当前版本**：`v0.1.0-beta.1` (Preview)
> 专为大型重构、全栈开发、多模块审计等需要多模型高效配合的复杂场景打造。

---

## 💡 为什么需要 Boss-Worker 模式？

在面对复杂大型任务（如全栈系统开发、大型项目重构、深度代码审计）时，单个大语言模型常受限于上下文窗口膨胀、跨文件编辑易冲突、自写自检盲区等问题。此外，全流程使用单一顶尖大模型成本高昂，而全流程使用轻量模型又难以保证顶层架构质量。

`dsh-boss-worker` 为 DSH 引入了分层治理架构（Lead-Worker Pattern），**深度融合 DSH 的多 Provider / 多 API 接入能力**：
- **主控模型 (Lead / Boss · 架构大脑)**：由当前会话的主模型担任，推荐选用顶层推理、逻辑与架构设计能力最强的模型（例如 **GPT-6.1 Sol**、**Claude Opus 5.5** 等）。专注全局拆解、边界把控与严苛审查；在开启 **BOSS 模式** 时被强制禁止直接写业务代码，专注系统统筹。
- **子模型集群 (Workers · 执行团队)**：通过 DSH 接入的不同 API 渠道与模型，按工种自由搭配组合。例如配置高吞吐代码模型（如 **DeepSeek-V4 Pro**）专攻功能实现，搭配高速轻量模型（如 **DeepSeek 4.1 Flash**、**Gemini Flash**）负责测试用例运行与静态检查。
- **混合协作优势**：兼具顶尖大模型的“架构智慧”与轻量模型的“低成本、高并发执行力”，多模型各扬所长，在保障工程质量的同时大幅缩短响应时间并降低 API 开销。
- **真实验收闭环 (Review Gate)**：子模型交付成果后进入 `review` 状态，必须由主控逐项对照验收标准严格核验，通过后才解锁依赖；未通过则带着具体问题打回重做。
- **全自动托管 (Autopilot)**：从规划、调度执行、主控独立审查到推进下一阶段的全自主闭环流水线，大幅解放人工干预。

---

## ✨ 核心特性

### 1. 异构多模型混合编排 (Heterogeneous Multi-Model Orchestration)
- **自由绑定任意 Provider & Model**：完全继承 DSH 的多模型接入能力，团队中的每个角色（Coder、Tester、Reviewer 等）均可独立配置不同的 API 渠道与模型。
- **典型搭配示例**：
  - **主控决策**：`GPT-6.1 Sol` 或 `Claude Opus 5.5`（负责顶层规划、接口设计与代码审查）。
  - **模块编码**：`DeepSeek-V4 Pro`（负责文件实现、逻辑编码）。
  - **验证测试**：`DeepSeek 4.1 Flash`（负责用例执行、断言验证与语法分析）。
- **任务级动态换脑**：不仅预设团队成员可混搭模型，用户还可在 Web 界面随时针对特定的待执行任务临时更换专精模型，按需调遣。

### 2. 严格的文件写入范围隔离 (Write Scope Isolation)
子任务在规划时必须明确相对文件或目录路径 (`writeScopes`)。调度引擎严格确保**任何重叠写入范围的任务串行化，无交集任务安全并行**，从根源消除多模型并发编辑造成的文件覆盖和代码冲突。

### 3. 独立质量门禁与审查机制 (Quality Gate & Review)
- 子任务不设自动完成。模型交付后统一流转至 `review` 状态。
- 主控模型必须调用 `lead_worker_review`，依据明确的测试依据和代码产出进行独立判定。
- 验收通过：解锁依赖项；验收未通过：记录审查意见并流转至返工。

### 4. 可控的返工生命周期 (Bounded Rework Lifecycle)
- 同一任务在授权范围内返工时，保留任务级执行授权与执行历史，无需繁琐的重复整板审批。
- 具备严格的重试预算 (`maxRetries`)，达到上限后挂起等待人工裁决，防止多模型循环消耗 Token。人工批准后仅追加单次执行机会，累计重试历史完整保留。
- 任务若扩大了文件范围或修改了关键依赖，旧执行授权立即自动失效，确保范围安全。

### 5. 任务专属模型动态路由 (Per-Task Model Routing)
- 支持在 Web 界面为特定任务自由切换专精模型（例如架构用主力模型，写代码用精通编程的模型，测试验证用轻量高速模型）。
- 专属路由严格绑定当前会话与特定任务，不会污染全局共享成员池，也不影响其它任务的正常调度。

### 6. 完备的执行排空与断点恢复 (Draining & Recovery)
- 支持任务板暂停、中断、排空结算（Drain）与检查点（Checkpoint）保存。
- 停工或关机前，系统等待正在运行的子任务完整结算，核实磁盘一致性后方可标记安全状态。
- DSH 宿主重启后完整恢复现场状态，不丢失历史、不清空看板，杜绝陈旧执行覆盖。

### 7. 无缝融合的 DSH Web 交互界面
- **双胶囊快捷开关**：在输入框右侧提供 `👔 BOSS 直派` 与 `🚀 全自动托管` 胶囊开关，实时生效。
- **三格实时悬浮条**：在界面直观展示当前会话的 `[运行中 蓝色]`、`[待审查 金色]`、`[待执行 紫色]` 任务数量。
- **任务看板与快捷操作卡片**：展开即可查看所有任务依赖图、负责人、验收标准；支持单个任务切换模型、手动派发与失败重试。

---

## 🔄 运行模式与工作流

### 模式配置说明

| 模式开关 | 作用域 | 说明 |
|---|---|---|
| **基本插件配置** | 全局共享 | 包括团队成员列表、并发上限 (`maxParallel`)、返工限制 (`maxRetries`)、模式 (`mixed/auto/manual`)。 |
| **👔 BOSS 直派 (Boss-Direct)** | 会话私有 | 限制当前会话的主控模型直接执行编码工具，强制其拆分子任务并派发执行。 |
| **🚀 全自动托管 (Autopilot)** | 会话私有 | 启用自动流水线。规划后自动派发，子任务交付后主控自动审查，全部完成后唤醒主控推进下一阶段。 |

> **提示**：为避免多会话互相影响，BOSS 直派与全自动托管开关均在每个会话中独立管理与持久化。

---

### 工作流 A：常规人机协同模式 (Human-in-the-Loop)

```mermaid
graph TD
    A[用户提出复杂需求] --> B[主控进行方案拆解与任务规划]
    B --> C{是否启用计划审批?}
    C -- 是 --> D[弹出交互式计划审批卡片]
    D -- 用户批准 --> E[任务板生效, 进入准备状态]
    D -- 用户拒绝 --> B
    C -- 否 --> E
    E --> F[调度引擎按依赖和文件范围并行派发]
    F --> G[子模型执行并提交成果]
    G --> H[成果进入待审查状态]
    H --> I[主控独立审查并给出反馈]
    I -- 审查通过 --> J{是否全部任务完成?}
    I -- 打回返工 --> K{是否超过重试上限?}
    K -- 未超限 --> F
    K -- 已超限 --> L[挂起并请求用户介入]
    J -- 是 --> M[阶段交付验收]
    J -- 否 --> F
```

1. 主控调用 `lead_worker_plan` 规划阶段任务。
2. 用户在聊天界面确认任务清单与责任人。
3. 调度器在并发与文件范围约束下安全分发任务。
4. 子任务完成后，主控核验并通过，自动解锁后续后继任务。

---

### 工作流 B：全自动托管模式 (Autopilot)

开启输入栏的 **`🚀 全自动托管`** 胶囊开关：
1. **自动规划与派发**：主控拆解任务后自动激活入队，首批无依赖任务即刻并行启动。
2. **自动闭环审查**：子模型完成后触发主控审查，合格自动放行下阶段，不合格在预算内就地重试。
3. **阶段连续推进**：当前阶段任务全部通过后，主控模型被阶段结算事件唤醒，结合项目全局目标调用 `lead_worker_plan(append=true)` 追加后续阶段任务，直至整个工程验收完成。

---

## 🛠️ 主控工具集 (Lead Tools)

主控模型通过以下 DSH 工具驱动完整协作网络：

| 工具名称 | 职责说明 |
|---|---|
| `lead_worker_status` | 查看当前任务板快照，包括任务状态、责任人、依赖进展及整体状态。 |
| `lead_worker_plan` | 拆解并提交任务列表，支持增量追加 (`append: true`) 与多阶段推进。 |
| `lead_worker_dispatch` | 触发安全调度，调度器自动在并发容量与无写冲突约束下启动就绪任务。 |
| `lead_worker_review` | 主控对子模型提交的结果进行独立审查（达标通过 / 不达标返工并附具体意见）。 |
| `lead_worker_list_members` | 动态查询当前可用成员数量、特长、配置模型与忙闲状态。 |
| `lead_worker_approve` | 人机审批流中，接收用户授权后正式激活任务板。 |
| `lead_worker_recovery` | 控制暂停、恢复、安全排空结算、保存断点或在故障后核查恢复。 |

---

## 📦 安装与接入

### 前置要求
- [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 运行时环境
- Node.js `>= 20.0.0`

### 接入 DSH 插件体系

插件通过 Cordis 机制注入 DSH 宿主服务，并在 Web 前端自动注册监控组件：

1. **获取项目代码**：
   将本仓库克隆至 DSH 的插件管理目录或项目依赖中：
   ```bash
   git clone https://github.com/kongbai9420/dsh-boss-worker.git
   ```

2. **配置补丁声明 (`cordis.patch.yml`)**：
   在 DSH 配置文件中添加插件引入：
   ```yaml
   - insert:
       - id: lead-worker
         name: "dsh-boss-worker"
         config:
           defaultConfig:
             enabled: true
             mode: mixed
             maxParallel: 4
             maxRetries: 2
             confirmPlan: true
             askApprovalPrompt: true
             members:
               # 子角色 A: 负责写代码，可选用高性价比/高吞吐代码模型
               - id: worker-coder
                 name: "Sol (代码执行)"
                 provider: "deepseek-official"
                 model: "deepseek-v4-pro"
                 role: "负责代码编写、文件修改与逻辑实现"
                 instructions: "严格在任务范围内编写代码并自测，提交改动文件与证据。"
                 enabled: true
                 readOnly: false
               # 子角色 B: 负责单元测试与静态检查，可选用轻量高速模型
               - id: worker-qa
                 name: "QA (验证测试)"
                 provider: "deepseek-official"
                 model: "deepseek-flash"
                 role: "负责测试运行、质量把关与静态检查"
                 instructions: "只读审查，执行测试用例，提供真实测试依据。"
                 enabled: true
                 readOnly: true
   ```

   > **💡 异构模型自由搭配技巧**：
   > - **主控角色 (Lead / Boss)**：直接继承当前 DSH 会话的主模型（例如在界面顶部选择 `GPT-6.1 Sol`、`Claude Opus 5.5` 等推理大脑），无需在 members 中重复声明。
   > - **子执行角色 (Workers)**：在 `members` 列表中自由绑定 DSH 接入的任意 Provider 与 Model（如 `deepseek-official / deepseek-v4-pro`、`deepseek-flash` 等），各司其职，最大化发挥多 API 混合协作的性价比与并发吞吐。

3. **数据持久化与 Profile 支持**：
   - 插件自动探测宿主当前运行的 Profile 上下文，将配置与任务状态独立持久化在各自的 Profile 数据目录下。
   - 包含跨会话配置安全合并机制与版本 CAS 防并发覆盖保障。

---

## 💻 开发者与测试

项目包含完备的单元测试、调度隔离测试与前端模拟套件：

```bash
# 运行全量核心与调度测试
npm test

# 运行前端组件与状态流模拟测试
npm run test:client

# 验证发布包完整性与白名单过滤
npm pack --dry-run
```

测试体系覆盖了：任务状态机、并发冲突判定、范围重规划授权延续、超限返工预算保护、API 同源安全门禁、多 Profile 独立持久化及 Web UI 状态流队列刷新等核心场景。

---

## 🙏 致谢与参考开源项目

本项目的设计与实现深受以下开源项目的启发，在此致敬与感谢：

- **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)**：提供了坚实的宿主底座、Subagent 执行系统与 Web 前端插槽扩展机制。
- **[Cordis](https://github.com/cordisjs/cordis)**：提供了优雅的微内核服务架构、上下文生命周期与插件依赖注入体系。
- **[ChatDev](https://github.com/OpenBMB/ChatDev) & [MetaGPT](https://github.com/geekan/MetaGPT)**：多智能体协作中软件工程标准作业程序（SOP）、分工角色化与主从质检机制的核心设计灵感来源。
- **[Schemastery](https://github.com/cordisjs/schemastery)**：模块化强类型 Schema 验证与运行时配置驱动规范。

---

## 📄 开源许可证

本项目基于 [MIT 许可证](LICENSE) 开源。欢迎自由使用、学习与贡献！
