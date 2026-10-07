export function teamAvailability(config, snapshot = { tasks: [] }) {
  const tasks = snapshot.tasks || [];
  const running = tasks.filter(t => t.status === 'running');
  const members = config.members.map(m => ({ ...m, busy: running.some(t => t.memberId === m.id), runningTaskIds: running.filter(t => t.memberId === m.id).map(t => t.id) }));
  const blockedTasks = tasks.filter(t => t.status === 'pending').map(t => ({
    taskId: t.id, memberId: t.memberId, locked: Boolean(t.locked),
    waitingDependencies: t.dependencies.filter(id => tasks.find(d => d.id === id)?.status !== 'done'),
    memberBusy: members.find(m => m.id === t.memberId)?.busy || false,
    writeScopeConflicts: running.filter(other => !t.readOnly && !other.readOnly &&
      !members.find(m => m.id === t.memberId)?.readOnly && !members.find(m => m.id === other.memberId)?.readOnly &&
      t.writeScopes.some(a => other.writeScopes.some(b => {
        const norm = s => s.replace(/\\/g, '/').replace(/\/$/, '');
        const x = norm(a), y = norm(b);
        return ['**', '.'].includes(x) || ['**', '.'].includes(y) || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
      }))).map(other => other.id),
  }));
  const enabled = members.filter(m => m.enabled);
  return { members, enabledCount: enabled.length, idleCount: enabled.filter(m => !m.busy).length,
    maxParallel: config.maxParallel, freeSlots: Math.max(0, config.maxParallel - running.length),
    potentialParallelism: Math.min(enabled.length, config.maxParallel), blockedTasks };
}
