// Host tool guards apply to every agent. Scope this policy to enabled root conversations.
const IMPLEMENTATION_TOOLS = new Set(['write', 'edit', 'apply_patch', 'bash', 'pwsh', 'terminal', 'workflow', 'cordis']);
export function bossGuardReason(exec, config) {
  if (!config?.enabled || config.bossDirect !== true && config.autopilot !== true) return undefined;
  const header = exec?.agent?.session?.header;
  if (!header?.id || header.parentSession || header.origin === 'subagent') return undefined;
  const name = String(exec.name || '').split('.').pop();
  const delegation = ['subagent', 'subagent_fork'].includes(name);
  if (!delegation && !IMPLEMENTATION_TOOLS.has(name)) return undefined;
  if (config.autopilot) return '全自动托管已开启：主控统一规划与审查，具体实施必须分配子模型。调用 lead_worker_list_members → lead_worker_plan（自动调度）→ lead_worker_review，并持续推进项目下一阶段；常规计划无需用户审批。';
  return 'BOSS直派已开启：主控只能只读调查、规划、派发和审查，不能直接实施或启动原生子智能体。请调用 lead_worker_list_members → lead_worker_plan → 用户确认后 lead_worker_approve → lead_worker_dispatch；查看 lead_worker_status 后逐项 lead_worker_review。';
}
export function requireParent(sessionId, exec, agents) {
  const parent = exec?.agent || agents?.get(sessionId);
  if (!parent?.session || !parent?.ctx) throw new Error('当前对话没有可用的主控 Agent。请在原对话调用 lead_worker_dispatch；网页按钮不能凭空创建父 Agent。');
  if (parent.session.header.id !== sessionId) throw new Error('主控 Agent 与任务板会话不匹配，拒绝派发');
  return parent;
}
