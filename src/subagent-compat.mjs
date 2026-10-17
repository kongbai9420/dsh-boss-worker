// DSH 0.2.1 manages child activations; older hosts expose a directly owned run.
// Keep the scheduler's single-run contract and let the host own cancellation.
export function startWorker(subagents, request, agents) {
  if (typeof subagents.startActivation === 'function') {
    return startManagedWorker(subagents, request, agents);
  }
  // Do not retry a rejected activation through another API: that could start
  // the same task twice after the host has already accepted it.
  if (typeof subagents.start === 'function') return subagents.start('spawn', request);
  return Promise.reject(new Error('当前 DSH 缺少支持的子任务接口（startActivation / start）'));
}

async function startManagedWorker(subagents, request, agents) {
    const { label, signal, persona, ...task } = request;
    // persona is no longer a start capability. Deliver the member's configured
    // instructions as part of this child's task instead of silently losing them.
    const prompt = persona
      ? [{ type: 'text', text: `【成员执行准则】\n${persona}` }, ...task.prompt]
      : task.prompt;
    const activation = await subagents.startActivation({
      provider: 'spawn',
      label,
      signal,
      request: { ...task, prompt },
      // The board sends its own review notice after recording the result.
      delivery: 'caller',
    });
    // An activation's startup signal stops owning cancellation after
    // publication. Forward later aborts to this exact activation's disposer.
    // Keep the same promise so the scheduler still observes teardown failures.
    let disposal;
    const dispose = () => {
      signal.removeEventListener('abort', onAbort);
      return disposal ??= Promise.resolve().then(() => activation.dispose());
    };
    const onAbort = () => { void dispose().catch(() => {}); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    return {
      id: activation.childId,
      childMode: 'unknown',
      localAgent: agents?.get(activation.childId),
      result: activation.result,
      dispose,
    };
}
