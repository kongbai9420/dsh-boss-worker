import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// No backend imports, APPDATA, real timers, disk writes or real network.
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function harness() {
  let plugin, cursor = 0, states = [], effects = [], effectSlots = [];
  const timers = new Map(), requests = [], storage = new Map(), listeners = new Map();
  let timerId = 0;
  const eventTarget = prefix => ({ addEventListener(name, fn) { const key = prefix + name; if (!listeners.has(key)) listeners.set(key, new Set()); listeners.get(key).add(fn); }, removeEventListener(name, fn) { listeners.get(prefix + name)?.delete(fn); } });
  const React = {
    Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; },
    useCallback: fn => fn,
    useEffect(fn, deps) { const i = cursor++; const old = effectSlots[i]; if (!old || deps.some((d, index) => d !== old.deps[index])) { effects.push(() => { old?.cleanup?.(); effectSlots[i] = { deps, cleanup: fn() }; }); } },
  };
  const document = { ...eventTarget('document:'), hidden: false, body: { style: { userSelect: 'text' } }, getElementById: () => ({}), head: {} };
  const window = { ...eventTarget('window:'), innerWidth: 800, innerHeight: 600, __ModuleLoader__: { load: spec => { plugin = spec.factory(name => name === 'react' ? React : {}); } } };
  vm.runInNewContext(source.replace('exports.apply = apply;', 'exports.testing = { subscribeView, taskElapsed, FloatingTaskMonitor, floatingPreferences, constrainFloating, dockFloating, LeadWorkerDialog, LeadWorkerAction }; exports.apply = apply;'), { window, document, AbortController, localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }, setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id), setInterval() { throw Error('unexpected interval'); }, clearInterval() {}, fetch(url, options) { assert.match(url, /^\/api\/lead-worker\/view\?sessionId=/); return new Promise((resolve, reject) => { requests.push({ url, options, resolve, reject }); options?.signal?.addEventListener('abort', () => reject(Error('aborted'))); }); } });
  const api = plugin.testing;
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { api, timers, requests, storage, document, window, listeners, flush,
    fire(ms) { const item = [...timers].find(([, value]) => value.ms === ms); assert.ok(item, `missing ${ms}ms timer`); timers.delete(item[0]); item[1].fn(); },
    emit(key, event) { for (const fn of listeners.get(key) || []) fn(event); },
    respond(index, data) { requests[index].resolve({ ok: true, json: async () => data }); },
    render(component, props) { cursor = 0; const tree = component(props); for (const fn of effects.splice(0)) fn(); return tree; },
    unmount() { effectSlots.forEach(slot => slot?.cleanup?.()); effectSlots = []; states = []; },
    newInstance() { const oldStates = states, oldEffects = effectSlots; states = []; effectSlots = []; return () => { states = oldStates; effectSlots = oldEffects; }; },
  };
}
const data = tasks => ({ ok: true, config: { members: [{ id: 'm1', name: '成员甲' }] }, board: { status: 'ready', tasks }, availability: { freeSlots: 0, blockedTasks: [{ taskId: 'pending', waitingDependencies: ['dep'], memberBusy: true, writeScopeConflicts: ['other'] }] } });
const ballNode = tree => nodes(tree).find(node => node.type === 'button' && node.props['data-state']);
const text = node => node && typeof node === 'object' ? node.children?.map(text).join('') || '' : typeof node === 'string' ? node : '';
function nodes(node) { return node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(nodes)] : []; }

test('one shared request per session, cadence, no overlap, hidden suspension and cleanup', async () => {
  const h = harness(); const a = [], b = [];
  const offA = h.api.subscribeView('A', 3000, value => a.push(value));
  const offB = h.api.subscribeView('A', 10000, value => b.push(value));
  h.fire(0); assert.equal(h.requests.length, 1);
  h.document.hidden = true; h.emit('document:visibilitychange');
  h.respond(0, data([])); await h.flush(); assert.equal(h.timers.size, 0);
  assert.equal(a.at(-1).data, b.at(-1).data);
  h.document.hidden = false; h.emit('document:visibilitychange'); h.fire(0);
  h.emit('document:visibilitychange'); h.fire(0); assert.equal(h.requests.length, 2, 'pending request is shared');
  h.respond(1, data([])); await h.flush(); h.fire(3000);
  h.respond(2, data([])); await h.flush(); offA(); h.fire(10000);
  offB(); await h.flush(); assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.get('document:visibilitychange').size, 0);
});

test('missing identity never fetches; old session response cannot replace new snapshot', async () => {
  const h = harness(); h.api.subscribeView(undefined, 3000, () => {}); assert.equal(h.timers.size, 0);
  const seen = []; const offA = h.api.subscribeView('A', 3000, v => seen.push(v)); h.fire(0); offA(); await h.flush();
  const offB = h.api.subscribeView('B', 3000, v => seen.push(v)); h.fire(0);
  h.respond(0, data([{ id: 'old' }])); h.respond(1, data([{ id: 'new' }])); await h.flush();
  assert.equal(seen.at(-1).sessionId, 'B'); assert.equal(seen.at(-1).data.board.tasks[0].id, 'new'); offB();
});

test('error preserves timestamp and flags stale data; timeout retries', async () => {
  const h = harness(); let snapshot; const off = h.api.subscribeView('A', 3000, v => { snapshot = v; });
  h.fire(0); h.respond(0, data([])); await h.flush(); const updated = snapshot.updatedAt;
  h.fire(3000); h.requests[1].reject(Error('offline')); await h.flush();
  assert.equal(snapshot.updatedAt, updated); assert.equal(snapshot.error, 'offline');
  h.fire(3000); h.fire(15000); await h.flush(); assert.ok(snapshot.error); h.fire(3000); assert.equal(h.requests.length, 4); off(); await h.flush();
});

test('real elapsed time uses latest start and matching terminal, never fabricates unknown', () => {
  const h = harness(); const start = '2026-01-01T00:00:00Z'; const end = '2026-01-01T00:01:12Z';
  assert.equal(h.api.taskElapsed({ status: 'running' }, Date.now()), '暂无耗时数据');
  const executionHistory = [{ status: 'started', epoch: 1, at: start }, { status: 'review', epoch: 1, at: end }];
  assert.equal(h.api.taskElapsed({ status: 'done', executionHistory }, Date.now()), '1分12秒');
  assert.equal(h.api.taskElapsed({ status: 'done', executionHistory: executionHistory.slice(0, 1) }, Date.now()), '暂无耗时数据');
  assert.equal(h.api.taskElapsed({ status: 'running', executionHistory: executionHistory.slice(0, 1) }, Date.parse(end)), '1分12秒');
});

test('read-only monitor renders counts, members, reasons, histories, honest stale status and themes', () => {
  for (const themeMode of ['light', 'dark']) {
    const h = harness(); const tasks = ['done', 'running', 'review', 'pending', 'needs_attention', 'failed'].map(status => ({ id: status, title: `任务${status}`, status, memberId: 'm1', retries: 2, result: { output: '真实结果' }, reviewHistory: [{ feedback: '审查意见' }], executionHistory: [{ status: 'recovery-confirmed', note: '已核查续做' }] }));
    const props = { sessionId: 'A', monitor: { sessionId: 'A', data: data(tasks), updatedAt: 1000, error: 'offline' }, prefs: { x: 24, y: 24, collapsed: false }, setPrefs() {}, themeMode, toggleTheme() {}, onOpen() {} };
    const tree = h.render(h.api.FloatingTaskMonitor, props), value = text(tree);
    assert.match(value, /已验收 1\/6/);
    assert.equal(nodes(tree).filter(n => n.props && n.props['data-status-stats']).length, 0);
    const progress = nodes(tree).find(n => n.props.role === 'progressbar');
    assert.equal(progress.props['aria-valuemax'], 6);
    assert.equal(progress.props['aria-valuenow'], 1);
    assert.equal(progress.children[0].props.style.width, `${1 / 6 * 100}%`);
    for (const label of ['成员甲', '暂无耗时数据', '返工次数：2', '等待依赖：dep', '成员忙碌', '写入范围冲突：other', '真实结果', '审查意见', '已核查续做', '同步失败', '旧快照，非实时', '上次更新时间', '工作台设置']) assert.ok(value.includes(label), label);
    assert.doesNotMatch(value, /%|\[object Object\]/); assert.equal(nodes(tree).filter(n => ['input', 'textarea', 'select'].includes(n.type)).length, 0);
    const wrong = h.render(h.api.FloatingTaskMonitor, { ...props, sessionId: 'B' }); assert.doesNotMatch(text(wrong), /真实结果|任务done/);
    h.unmount(); assert.equal(h.listeners.get('window:resize').size, 0);
  }
});

test('Action reuses shared stream for full panel and float, preferences persist and float has one owner', async () => {
  const h = harness(), props = { sessionId: 'A' };
  let tree = h.render(h.api.LeadWorkerAction, props);
  assert.equal(nodes(tree).filter(n => n.type === h.api.FloatingTaskMonitor).length, 0, 'no snapshot is not invented');
  assert.ok(!nodes(tree).some(n => n.type === 'button' && text(n) === '任务监控'));
  h.fire(0); h.respond(0, data([{ id: 'running', status: 'running' }])); await h.flush();
  tree = h.render(h.api.LeadWorkerAction, props);
  assert.equal(nodes(tree).filter(n => n.type === h.api.FloatingTaskMonitor).length, 1);
  assert.ok([...h.timers.values()].some(timer => timer.ms === 10000));
  assert.equal(nodes(tree).filter(n => n.type === h.api.LeadWorkerDialog).length, 0, 'Action does not render a standalone dialog');
  let floating = nodes(tree).find(n => n.type === h.api.FloatingTaskMonitor);
  assert.equal(floating.props.workspaceTab, 'tasks');
  assert.equal(floating.props.prefs.collapsed, true);
  floating.props.setPrefs(prev => ({ ...prev, visible: false }));
  tree = h.render(h.api.LeadWorkerAction, props);
  assert.equal(nodes(tree).filter(n => n.type === h.api.FloatingTaskMonitor).length, 0);
  assert.equal(JSON.parse(h.storage.get('dsh_lead_worker_floating_v1')).visible, false);
  nodes(tree).find(n => n.type === 'button' && n.props.title === '打开统一协作工作台：任务、角色与设置').props.onClick();
  tree = h.render(h.api.LeadWorkerAction, props);
  floating = nodes(tree).find(n => n.type === h.api.FloatingTaskMonitor);
  assert.equal(floating.props.workspaceTab, 'lead');
  assert.equal(floating.props.prefs.visible, true);
  assert.equal(floating.props.prefs.collapsed, false);
  const saved = JSON.parse(h.storage.get('dsh_lead_worker_floating_v1'));
  assert.equal(saved.visible, true); assert.equal(saved.collapsed, false);
  assert.equal(nodes(tree).filter(n => n.type === h.api.LeadWorkerDialog).length, 0);
  assert.equal(h.requests.length, 1); assert.ok([...h.timers.values()].some(timer => timer.ms === 3000));
  const restore = h.newInstance(); h.render(h.api.LeadWorkerAction, props);
  const second = h.render(h.api.LeadWorkerAction, props);
  assert.equal(nodes(second).filter(n => n.type === h.api.FloatingTaskMonitor).length, 0);
  h.unmount(); restore(); h.unmount(); await h.flush();
  assert.equal(h.timers.size, 0);
});

test('workspace navigation embeds one shared dialog for roles and settings, then returns to tasks', () => {
  const h = harness(); let workspaceTab = 'tasks';
  let prefs = { x: 12, y: 20, collapsed: false, visible: true };
  const monitor = { sessionId: 'A', data: data([{ id: 'task', status: 'running' }]) };
  const props = { sessionId: 'A', monitor, themeMode: 'light', toggleTheme() {},
    setWorkspaceTab: tab => { workspaceTab = tab; },
    setPrefs: update => { prefs = typeof update === 'function' ? update(prefs) : update; } };
  const render = () => h.render(h.api.FloatingTaskMonitor, { ...props, prefs, workspaceTab });
  let tree = render();
  const nav = nodes(tree).find(n => n.type === 'nav' && n.props['aria-label'] === '工作台区域');
  assert.deepEqual(nav.children.map(text), ['任务', '角色', '设置']);
  assert.deepEqual(nav.children.map(n => n.props['aria-pressed']), [true, false, false]);
  const dialogWrapper = tree => nodes(tree).find(n => n.children?.some(child => child?.type === h.api.LeadWorkerDialog));
  const initialDialog = nodes(tree).find(n => n.type === h.api.LeadWorkerDialog);
  assert.ok(initialDialog, 'dialog remains mounted to preserve drafts on task tab');
  assert.equal(dialogWrapper(tree).props.style.display, 'none');
  for (const [tab, label] of [['members', '角色'], ['lead', '设置']]) {
    nodes(tree).find(n => n.type === 'button' && text(n) === label).props.onClick();
    assert.equal(workspaceTab, tab); tree = render();
    const dialogs = nodes(tree).filter(n => n.type === h.api.LeadWorkerDialog);
    assert.equal(dialogs.length, 1);
    const dialog = dialogs[0];
    assert.equal(dialog.props.key, initialDialog.props.key, 'navigation keeps dialog identity');
    assert.equal(dialogWrapper(tree).props.style.display, 'flex');
    assert.equal(dialog.props.embedded, true); assert.equal(dialog.props.isOpen, true);
    assert.equal(dialog.props.initialTab, tab); assert.equal(dialog.props.sessionId, 'A');
    assert.equal(dialog.props.monitor, monitor, 'embedded dialog reuses the monitor snapshot');
    assert.equal(dialog.props.floatingVisible, true);
    assert.equal(nodes(tree).filter(n => n.props['data-task-list']).length, 0);
    assert.equal(nodes(tree).find(n => n.type === 'button' && text(n) === label).props['aria-pressed'], true);
    dialog.props.onClose(); assert.equal(workspaceTab, 'tasks'); tree = render();
    assert.equal(nodes(tree).filter(n => n.type === h.api.LeadWorkerDialog).length, 1);
    assert.equal(dialogWrapper(tree).props.style.display, 'none');
    assert.equal(nodes(tree).find(n => n.type === h.api.LeadWorkerDialog).props.key, initialDialog.props.key);
    assert.equal(nodes(tree).filter(n => n.props['data-task-list']).length, 1);
  }
  nodes(tree).find(n => n.type === 'button' && text(n) === '工作台设置').props.onClick();
  tree = render();
  nodes(tree).find(n => n.type === h.api.LeadWorkerDialog).props.toggleFloating(false);
  assert.equal(prefs.visible, false);
  nodes(tree).find(n => n.type === 'button' && text(n) === '返回任务').props.onClick();
  assert.equal(workspaceTab, 'tasks');
  assert.equal(h.requests.length, 0, 'navigation does not create requests or backend writes');
  h.unmount();
});

test('prefs migration defaults to ball, respects saved false, clamps tiny screens', () => {
  const h = harness();
  assert.equal(h.api.floatingPreferences().visible, true); assert.equal(h.api.floatingPreferences().collapsed, true);
  assert.equal(h.api.floatingPreferences().cardWidth, 410); assert.equal(h.api.floatingPreferences().cardHeight, 620);
  h.storage.set('dsh_lead_worker_floating_v1', '{invalid'); assert.equal(h.api.floatingPreferences().visible, true);
  h.storage.set('dsh_lead_worker_floating_v1', JSON.stringify({ visible: false, collapsed: false, x: 99, cardWidth: 520, cardHeight: 700 }));
  assert.equal(h.api.floatingPreferences().visible, false); assert.equal(h.api.floatingPreferences().collapsed, true);
  assert.equal(h.api.floatingPreferences().cardWidth, 520); assert.equal(h.api.floatingPreferences().cardHeight, 700);
  assert.equal(h.api.constrainFloating({ x: 10000, y: -10, cardWidth: 520 }).cardWidth, 520);
  assert.equal(h.api.constrainFloating({ x: 10000, y: -10 }).x, 540);
  assert.equal(h.api.dockFloating({ x: 400, y: 20 }).x, 528);
  assert.equal(h.api.dockFloating({ x: 20, y: 20 }).x, 12);
  h.window.innerWidth = 40; h.window.innerHeight = 30;
  const tiny = h.api.dockFloating({ x: 999, y: 999 }); assert.equal(tiny.x, 0); assert.equal(tiny.y, 0);
});

test('persistent ball toggles twice and drags freely in both modes, suppressing click and selection', () => {
  const h = harness(); let prefs = { x: 12, y: 20, collapsed: true, visible: true }, opened = false;
  const props = { sessionId: 'A', monitor: { sessionId: 'A', data: data([{ id: 't', status: 'running' }]) }, setPrefs: update => { prefs = typeof update === 'function' ? update(prefs) : update; }, themeMode: 'light', toggleTheme() {}, setWorkspaceTab: tab => { opened = tab === 'lead'; } };
  const render = () => h.render(h.api.FloatingTaskMonitor, { ...props, prefs });
  let tree = render(); assert.equal(tree.type, 'fragment'); assert.match(ballNode(tree).props['aria-label'], /运行 1.*展开/);
  const ballKey = ballNode(tree).props.key;
  const down = () => ballNode(tree).props.onPointerDown({ pointerId: 1, clientX: 12, clientY: 20 });
  down(); tree = render();
  assert.equal(h.document.body.style.userSelect, 'none');
  let blockedSelection = false; h.emit('document:selectstart', { preventDefault() { blockedSelection = true; } }); assert.equal(blockedSelection, true);
  h.emit('window:pointermove', { pointerId: 1, clientX: 15, clientY: 24 });
  assert.equal(prefs.x, 12, 'exactly 5px is not a drag');
  h.emit('window:pointerup', { pointerId: 1 }); tree = render(); ballNode(tree).props.onClick({ detail: 1 });
  tree = render(); assert.equal(prefs.collapsed, false);
  nodes(tree).find(n => text(n) === '工作台设置' && n.type === 'button').props.onClick(); assert.equal(opened, true);
  assert.equal(ballNode(tree).props.key, ballKey); assert.equal(ballNode(tree).props['aria-expanded'], true);
  assert.match(ballNode(tree).props['aria-label'], /点击收起/);
  assert.equal(nodes(tree).filter(n => n.type === 'button' && text(n) === '收起').length, 0);
  ballNode(tree).props.onClick({ detail: 1 }); tree = render();
  assert.equal(prefs.collapsed, true); assert.equal(ballNode(tree).props.key, ballKey);
  ballNode(tree).props.onClick({ detail: 0 }); tree = render();
  assert.equal(prefs.collapsed, false, 'drag also works with the card expanded');
  down(); tree = render(); h.emit('window:pointermove', { pointerId: 1, clientX: 700, clientY: 9999 });
  assert.equal(prefs.y, 566); h.emit('window:pointerup', { pointerId: 1 }); tree = render(); assert.equal(prefs.x, 540, 'drag clamps to the visible status bar width');
  ballNode(tree).props.onClick({ detail: 1 }); assert.equal(prefs.collapsed, false, 'drag does not toggle expanded ball');
  ballNode(tree).props.onClick({ detail: 0 }); assert.equal(prefs.collapsed, true, 'native keyboard activation works');
  tree = render(); assert.equal(h.listeners.get('window:pointermove').size, 0);
  assert.equal(h.document.body.style.userSelect, 'text'); assert.equal(h.listeners.get('document:selectstart').size, 0);
  h.unmount(); assert.equal(h.requests.length, 0);
});

test('floating card resizes from 8-direction handles, clamps bounds and updates persisted layout', () => {
  const h = harness();
  h.window.innerWidth = 800;
  h.window.innerHeight = 900;
  let prefs = { x: 12, y: 20, collapsed: false, visible: true, cardWidth: 410, cardHeight: 620 };
  const props = { sessionId: 'A', monitor: { sessionId: 'A', data: data([{ id: 't', status: 'running' }]) }, setPrefs: update => { prefs = typeof update === 'function' ? update(prefs) : update; }, themeMode: 'light', toggleTheme() {}, onOpen() {} };
  const render = () => h.render(h.api.FloatingTaskMonitor, { ...props, prefs });
  let tree = render();

  const seGrip = nodes(tree).find(n => n.props.role === 'separator' && n.props['aria-label'] === '右下角拉伸');
  const nwGrip = nodes(tree).find(n => n.props.role === 'separator' && n.props['aria-label'] === '左上角拉伸');
  const eEdge = nodes(tree).find(n => n.props.role === 'separator' && n.props['aria-label'] === '右侧拉伸边');
  const nEdge = nodes(tree).find(n => n.props.role === 'separator' && n.props['aria-label'] === '顶部拉伸边');

  assert.ok(seGrip && nwGrip && eEdge && nEdge, '8-direction resize handles exist');
  assert.equal(seGrip.props.style.cursor, 'nwse-resize');
  assert.equal(eEdge.props.style.cursor, 'ew-resize');
  assert.equal(nEdge.props.style.cursor, 'ns-resize');

  // 1. 右下角向外拖拽放大
  seGrip.props.onPointerDown({ pointerId: 9, clientX: 500, clientY: 500 });
  tree = render();
  assert.equal(h.document.body.style.userSelect, 'none');

  h.emit('window:pointermove', { pointerId: 9, clientX: 600, clientY: 550 });
  assert.equal(prefs.cardWidth, 510);
  assert.equal(prefs.cardHeight, 670);

  h.emit('window:pointermove', { pointerId: 9, clientX: 9999, clientY: 9999 });
  // origX 为 76 (12 + 56 + 8)，因此向右最大延伸至视口右边界为 800 - 76 = 724
  assert.equal(prefs.cardWidth, 520);
  assert.equal(prefs.cardHeight, 880);

  h.emit('window:pointerup', { pointerId: 9 });
  tree = render();
  assert.equal(h.listeners.get('window:pointermove').size, 0);

  // 2. 左上角拉伸，坐标应动态向左/向上平移并增加宽高
  const origX = prefs.cardX;
  const origY = prefs.cardY;
  const origW = prefs.cardWidth;
  const origH = prefs.cardHeight;

  nwGrip.props.onPointerDown({ pointerId: 10, clientX: 100, clientY: 100 });
  tree = render();
  h.emit('window:pointermove', { pointerId: 10, clientX: 80, clientY: 70 });
  assert.ok(prefs.cardWidth > origW);
  assert.ok(prefs.cardHeight > origH);
  h.emit('window:pointerup', { pointerId: 10 });
  tree = render();

  assert.equal(h.document.body.style.userSelect, 'text');
  h.unmount();
});

test('status colors, actual running count, empty-session hiding and explicit error warning', () => {
  for (const [statuses, state, _legacyColor, count] of [
    [['running', 'running'], 'running', '#0071e3', 2],
    [['running', 'review'], 'attention', '#ff9500', 1],
    [['running', 'review', 'pending'], 'attention', '#ff9500', 1],
    [['review', 'needs_attention'], 'attention', '#ff9500', 0],
    [['needs_attention'], 'attention', '#ff9500', 0],
    [['done', 'done'], 'done', '#248a3d', 0],
    [['pending'], 'pending', '#6e6e73', 0],
    [['failed'], 'error', '#d70015', 0],
  ]) {
    const h = harness(); const tree = ballNode(h.render(h.api.FloatingTaskMonitor, { sessionId: 'A', monitor: { sessionId: 'A', data: data(statuses.map((status, i) => ({ id: i, status }))) }, prefs: { x: 12, y: 80, collapsed: true }, setPrefs() {}, themeMode: 'light' }));
    assert.equal(tree.props['data-state'], state);
    assert.equal(tree.props.style.background, 'rgba(20, 24, 33, 0.95)');
    assert.match(tree.props['aria-label'], new RegExp(`运行 ${count}`));
    assert.equal(tree.props.style.width, 260);

    const cells = nodes(tree).filter(n => n.props && n.props['data-status-cell']);
    assert.equal(cells.length, 3);
    const runningCell = cells.find(n => n.props['data-status-cell'] === 'running');
    const reviewCell = cells.find(n => n.props['data-status-cell'] === 'review');
    const pendingCell = cells.find(n => n.props['data-status-cell'] === 'pending');
    assert.ok(runningCell && reviewCell && pendingCell);
    for (const [cell, active, color] of [
      [runningCell, statuses.includes('running'), '#1674ed'],
      [reviewCell, statuses.includes('review'), '#ffb020'],
      [pendingCell, statuses.some(s => ['pending', 'needs_attention', 'failed'].includes(s)), '#8650e8']
    ]) {
      assert.equal(cell.props['data-active'], active);
      assert.equal(cell.props.style.background, active ? color : '#292d34');
    }
    assert.match(text(runningCell), /运行中/);
    assert.match(text(reviewCell), /审计中/);
    assert.match(text(pendingCell), /待执行/);
    h.unmount();
  }
  const h = harness(); const props = { sessionId: 'A', prefs: { x: 12, y: 80, collapsed: true }, setPrefs() {} };
  // Updates independently activate/deactivate each cell, even when the overall
  // ball state remains attention. A highlight is not a mutually exclusive mode.
  for (const statuses of [['running'], ['running', 'review'], ['review', 'pending'], ['pending'], []]) {
    const ball = ballNode(h.render(h.api.FloatingTaskMonitor, { ...props, monitor: { sessionId: 'A', data: data(statuses.map((status, id) => ({ id, status }))) } }));
    const cells = nodes(ball).filter(node => node.props['data-status-cell']);
    assert.deepEqual(cells.map(node => node.props['data-active']), ['running', 'review', 'pending'].map(status => statuses.includes(status)));
    assert.deepEqual(cells.map(node => node.props.style.background), ['#1674ed', '#ffb020', '#8650e8'].map((color, index) => statuses.includes(['running', 'review', 'pending'][index]) ? color : '#292d34'));
  }
  const empty = ballNode(h.render(h.api.FloatingTaskMonitor, { ...props, monitor: { sessionId: 'A', data: data([]) } }));
  assert.equal(empty.type, 'button'); assert.match(empty.props.title, /暂无任务/);
  assert.doesNotMatch(text(empty), /返工/);
  const retry = h.render(h.api.FloatingTaskMonitor, { ...props, prefs: { ...props.prefs, collapsed: false }, monitor: { sessionId: 'A', data: data([{ status: 'pending', retries: 2 }, { status: 'done', retries: 3 }]) } });
  assert.match(text(retry), /返工次数：2/); assert.match(text(retry), /返工次数：3/);
  assert.doesNotMatch(text(retry), /返工 5|当前轮返工/);
  assert.doesNotMatch(ballNode(retry).props.title + ballNode(retry).props['aria-label'] + text(ballNode(retry)), /返工/);
  const warning = ballNode(h.render(h.api.FloatingTaskMonitor, { ...props, monitor: { sessionId: 'A', error: 'offline' } }));
  assert.equal(warning.props['data-state'], 'error'); assert.match(warning.props.title, /同步失败.*旧快照/);
  const switched = ballNode(h.render(h.api.FloatingTaskMonitor, { ...props, sessionId: 'B', monitor: { sessionId: 'A', data: data([{ status: 'running' }]) } }));
  assert.match(switched.props['aria-label'], /运行 0/); assert.match(switched.props.title, /正在同步/);
});

test('task stages use real dependencies, reviews and statuses, with per-task known and unknown retries', () => {
  const cases = [
    [{ status: 'pending', dependencies: ['dep'], retries: 2 }, '等待依赖'],
    [{ status: 'pending', retries: 1 }, '返工待执行'],
    [{ status: 'pending', retries: 0, reviewHistory: [{ passed: false }] }, '返工待执行'],
    [{ status: 'pending', retries: 0 }, '待分配'],
    [{ status: 'pending', memberId: 'm1', dependencies: ['done-dep'] }, '待派发'],
    [{ status: 'running', retries: 0 }, '执行中'],
    [{ status: 'running', retries: 2 }, '返工执行中'],
    [{ status: 'running', reviewHistory: [{ passed: false }] }, '返工执行中'],
    [{ status: 'review' }, '待主控审查'], [{ status: 'done' }, '已验收'],
    [{ status: 'needs_attention', waitingReason: 'RETRY_LIMIT_REACHED' }, '等待额外返工授权'],
    [{ status: 'needs_attention' }, '已中断或失败，等待重试'],
    [{ status: 'failed' }, '执行失败'], [{ status: 'cancelled' }, '已取消'],
  ];
  for (const [task, stage] of cases) {
    const h = harness(); const snapshot = data([{ id: 'subject', ...task }, { id: 'done-dep', status: 'done' }, { id: 'dep', status: 'running' }]);
    snapshot.availability = {};
    const tree = h.render(h.api.FloatingTaskMonitor, { sessionId: 'A', monitor: { sessionId: 'A', data: snapshot }, prefs: { x: 12, y: 80, collapsed: false }, setPrefs() {} });
    const article = nodes(tree).find(n => n.type === 'article' && n.props.key === 'subject');
    assert.ok(text(article).includes(`当前环节：${stage}`), JSON.stringify(task));
    assert.ok(text(article).includes(`返工次数：${task.retries ?? '暂无数据'}`));
    if (stage === '等待依赖') assert.match(text(article), /等待依赖：dep/);
    assert.doesNotMatch(text(article), /编码中|测试中|代码进度|测试进度|\d+%/);
    h.unmount();
  }
});

test('card avoids the anchored ball on right, left and narrow screens, ball remains above card', () => {
  for (const [width, height, x, y, side] of [[800, 600, 12, 80, 'right'], [800, 600, 732, 80, 'left'], [320, 600, 140, 80, 'vertical'], [40, 30, 0, 0, 'tiny']]) {
    const h = harness(); h.window.innerWidth = width; h.window.innerHeight = height;
    const tree = h.render(h.api.FloatingTaskMonitor, { sessionId: 'A', monitor: { sessionId: 'A', data: data([]) }, prefs: { x, y, collapsed: false }, setPrefs() {} });
    const ball = ballNode(tree), card = nodes(tree).find(n => n.type === 'section'), s = card.props.style;
    assert.equal(ball.props.style.left, Math.min(x, Math.max(0, width - ball.props.style.width))); assert.equal(ball.props.style.top, Math.min(y, Math.max(0, height - 48)));
    assert.ok(ball.props.style.zIndex > s.zIndex);
    assert.ok(s.left >= 0 && s.top >= 0 && s.left + s.width <= width && s.top + s.height <= height);
    if (side === 'right') assert.ok(s.left >= ball.props.style.left + ball.props.style.width);
    if (side === 'left') assert.ok(s.left + s.width <= ball.props.style.left);
    if (side === 'vertical') assert.ok(s.top >= ball.props.style.top + 48 || s.top + s.height <= ball.props.style.top);
    const heading = nodes(tree).find(n => text(n) === '协作工作台');
    assert.ok(heading); assert.equal(heading.props.onPointerDown, undefined);
    h.unmount();
  }
});

test('details use readable real records, not a whole raw JSON blob', () => {
  const h = harness();
  const task = { id: 'detail', status: 'review', result: { output: 'actual output', error: 'actual error', files: ['src/actual.js'], extra: { count: 7 } }, feedback: 'current feedback', reviewHistory: [{ passed: false, feedback: 'fix test', attempt: 2 }, { passed: true, feedback: 'verified', attempt: 3 }], checkpoint: { note: 'checkpoint note' }, executionHistory: [{ status: 'recovery-confirmed', note: 'confirmed note' }, { status: 'started', note: 'not a confirmation' }] };
  const props = { sessionId: 'A', monitor: { sessionId: 'A', data: data([task]) }, prefs: { x: 12, y: 80, collapsed: false }, setPrefs() {} };
  const tree = h.render(h.api.FloatingTaskMonitor, props);
  const details = nodes(tree).find(n => n.type === 'details');
  assert.deepEqual(nodes(details).filter(n => n.props['data-detail-section']).map(n => n.props['data-detail-section']), ['结果', '审查', '续做']);
  for (const label of ['actual output', 'actual error', 'src/actual.js', 'current feedback', '未通过', '通过', 'attempt：2', 'attempt：3', 'fix test', 'verified', 'checkpoint note', 'confirmed note', '其他结果信息', '"count": 7']) assert.ok(text(details).includes(label), label);
  assert.equal(nodes(details).filter(n => n.type === 'pre').length, 0);
  assert.doesNotMatch(text(details), /"result"|"reviewHistory"|"executionHistory"|"checkpoint"|not a confirmation|\[object Object\]/);
  const empty = h.render(h.api.FloatingTaskMonitor, { ...props, monitor: { sessionId: 'A', data: data([{ id: 'none', status: 'pending' }]) } });
  assert.match(text(nodes(empty).find(n => n.type === 'details')), /暂无记录/);
  const list = nodes(tree).find(n => n.props['data-task-list']);
  assert.equal(list.props.style.overflowY, 'auto');
  assert.equal(nodes(tree).find(n => n.type === 'header').props.style.flexShrink, 0);
  assert.equal(nodes(tree).find(n => n.type === 'footer').props.style.flexShrink, 0);
  assert.equal(nodes(tree).find(n => n.props.key === 'task-card').props.style.width, 410);
  h.unmount();
});

test('empty, initial loading and failed sync stay distinct with no fake denominator', () => {
  for (const [monitor, state, label] of [[{ sessionId: 'A', data: data([]) }, 'empty', '当前会话暂无任务'], [{ sessionId: 'A', syncing: true }, 'loading', '正在同步任务快照'], [{ sessionId: 'A', error: 'offline' }, 'error', '任务快照加载失败']]) {
    const h = harness();
    const tree = h.render(h.api.FloatingTaskMonitor, { sessionId: 'A', monitor, prefs: { x: 12, y: 80, collapsed: false }, setPrefs() {} });
    assert.equal(nodes(tree).find(n => n.props['data-empty-state']).props['data-empty-state'], state);
    assert.ok(text(tree).includes(label));
    assert.equal(nodes(tree).filter(n => n.props.role === 'progressbar').length, 0);
    if (state === 'loading') assert.doesNotMatch(text(tree), /已验收 0\/0|运行 0/);
    h.unmount();
  }
});

test('full panel offers accessible UI-only preference without extra hooks or backend writes', () => {
  const h = harness(); let visible = true;
  const props = { sessionId: 'A', isOpen: true, themeMode: 'light', floatingVisible: true, toggleFloating: value => { visible = value; }, monitor: { sessionId: 'A', data: data([]) } };
  const tree = h.render(h.api.LeadWorkerDialog, props);
  const toggle = nodes(tree).find(n => n.props['aria-label'] === '显示悬浮任务球');
  assert.equal(toggle.props.checked, true); toggle.props.onChange({ target: { checked: false } }); assert.equal(visible, false);
  assert.equal(h.requests.length, 0);
});

test('floating monitor distinct three boxes for running, review, pending/needs_attention and isolated history', () => {
  const h = harness();
  const snapshotData = {
    ok: true,
    config: {
      members: [
        { id: 'm1', name: '开发甲', model: 'deepseek-coder', role: '核心开发' },
        { id: 'm2', name: '审计乙', model: 'deepseek-chat', role: '安全审计' },
      ]
    },
    board: {
      status: 'paused',
      approved: false,
      tasks: [
        { id: 't-run', title: '执行中的代码编写', status: 'running', memberId: 'm1' },
        { id: 't-rev', title: '待审查的代码提交', status: 'review', memberId: 'm2' },
        { id: 't-pend', title: '依赖等待的任务', status: 'pending', memberId: 'm1', dependencies: ['dep-x'] },
        { id: 't-attn', title: '被中断的现场任务', status: 'needs_attention', memberId: 'm1', waitingReason: 'INTERRUPTED_RESTART' },
        { id: 't-done', title: '已成功归档任务', status: 'done', memberId: 'm1' },
        { id: 't-canc', title: '已取消的废弃任务', status: 'cancelled', memberId: 'm1' },
        { id: 't-fail', title: '已失败的异常任务', status: 'failed', memberId: 'm1' },
      ]
    },
    availability: {
      freeSlots: 0,
      blockedTasks: [
        { taskId: 't-pend', waitingDependencies: ['dep-x'], memberBusy: true }
      ]
    }
  };

  const props = {
    sessionId: 'A',
    monitor: { sessionId: 'A', data: snapshotData, updatedAt: 1000 },
    prefs: { x: 12, y: 80, collapsed: false },
    setPrefs() {},
    themeMode: 'light',
    toggleTheme() {},
    onOpen() {}
  };

  const tree = h.render(h.api.FloatingTaskMonitor, props);

  // 1. 三个独立框与历史框均存在
  const runningBox = nodes(tree).find(n => n.props['data-task-box'] === 'running');
  const reviewBox = nodes(tree).find(n => n.props['data-task-box'] === 'review');
  const pendingBox = nodes(tree).find(n => n.props['data-task-box'] === 'pending');
  const historyBox = nodes(tree).find(n => n.props['data-task-box'] === 'history');

  assert.ok(runningBox, 'running box exists');
  assert.ok(reviewBox, 'review box exists');
  assert.ok(pendingBox, 'pending box exists');
  assert.ok(historyBox, 'history box exists');

  // 2. 数量验证
  assert.equal(text(nodes(runningBox).find(n => n.props['data-box-count'] === 'running')), '1');
  assert.equal(text(nodes(reviewBox).find(n => n.props['data-box-count'] === 'review')), '1');
  assert.equal(text(nodes(pendingBox).find(n => n.props['data-box-count'] === 'pending')), '2');
  assert.equal(text(nodes(historyBox).find(n => n.props['data-box-count'] === 'history')), '3');

  // 3. 任务分配严格隔离，不混入
  const runningArticles = nodes(runningBox).filter(n => n.type === 'article').map(n => n.props.key);
  const reviewArticles = nodes(reviewBox).filter(n => n.type === 'article').map(n => n.props.key);
  const pendingArticles = nodes(pendingBox).filter(n => n.type === 'article').map(n => n.props.key);
  const historyArticles = nodes(historyBox).filter(n => n.type === 'article').map(n => n.props.key);

  assert.deepEqual(runningArticles, ['t-run']);
  assert.deepEqual(reviewArticles, ['t-rev']);
  assert.deepEqual(pendingArticles, ['t-pend', 't-attn']);
  assert.deepEqual(historyArticles, ['t-done', 't-canc', 't-fail']);

  // 历史绝对不混入三区
  for (const histId of ['t-done', 't-canc', 't-fail']) {
    assert.ok(!runningArticles.includes(histId));
    assert.ok(!reviewArticles.includes(histId));
    assert.ok(!pendingArticles.includes(histId));
  }

  // 4. 待执行原因：待核查续做 / 依赖 / 暂停 / 未批准原因
  const pendingText = text(pendingBox);
  assert.match(pendingText, /等待依赖：dep-x/);
  assert.match(pendingText, /批次已暂停派发|批次已暂停/);
  assert.match(pendingText, /未批准原因：计划待主控或用户批准/);
  assert.match(pendingText, /重启中断，等待核查续做/);

  // 恢复标记验证
  const recoveryMarker = nodes(pendingBox).find(n => n.props['data-recovery-marker']);
  assert.ok(recoveryMarker, 'recovery marker badge exists in pending/attention box');
  assert.equal(text(recoveryMarker), '【待恢复 / 重试】');

  // 5. 成员/模型与任务标题展示
  assert.match(text(runningBox), /执行中的代码编写/);
  assert.match(text(runningBox), /开发甲 · 模型：deepseek-coder/);
  assert.match(text(reviewBox), /审计乙 · 模型：deepseek-chat/);

  // 6. 停工 draining / 未安全关机显著提示
  const drainWarning = nodes(tree).find(n => n.props['data-drain-warning']);
  assert.ok(drainWarning, 'drain warning alert is rendered when paused with running tasks');
  assert.match(text(drainWarning), /停工收尾中 \(draining\) \/ 未安全关机/);

  // 7. 不重复模型选择开关；设置入口切换到统一工作台
  const bossBtn = nodes(tree).find(n => n.props['aria-label'] === '悬浮卡片切换BOSS直派');
  assert.equal(bossBtn, undefined, 'floating card must not duplicate the model-selector switch');
  const openBtn = nodes(tree).find(n => n.type === 'button' && text(n) === '工作台设置');
  assert.ok(openBtn, 'workspace settings entry remains');

  h.unmount();
});

test('floating monitor renders box empty states when sections have zero tasks', () => {
  const h = harness();
  // 只有 1 个 running 任务，review 和 pending 为 0
  const snapshotOnlyRun = {
    ok: true,
    config: { members: [{ id: 'm1', name: '成员甲' }] },
    board: {
      status: 'ready',
      tasks: [{ id: 't-run', title: '单项运行', status: 'running', memberId: 'm1' }]
    }
  };

  const tree = h.render(h.api.FloatingTaskMonitor, {
    sessionId: 'A',
    monitor: { sessionId: 'A', data: snapshotOnlyRun },
    prefs: { x: 12, y: 80, collapsed: false },
    setPrefs() {}
  });

  const emptyReview = nodes(tree).find(n => n.props['data-box-empty'] === 'review');
  const emptyPending = nodes(tree).find(n => n.props['data-box-empty'] === 'pending');
  assert.ok(emptyReview, 'empty review state exists');
  assert.equal(text(emptyReview), '暂无待审查任务');
  assert.ok(emptyPending, 'empty pending state exists');
  assert.equal(text(emptyPending), '暂无待执行任务');

  // 不处于 draining 状态时无关机警示
  assert.equal(nodes(tree).filter(n => n.props['data-drain-warning']).length, 0);

  h.unmount();
});
