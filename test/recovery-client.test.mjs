import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Isolated client-only harness: no server imports, disk writes, APPDATA, or real network.
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function harness({ status = 'paused', tasks = [], recovery, themeMode = 'light' } = {}) {
  const data = { ok: true, board: { status, tasks, recovery }, config: { members: [], maxParallel: 2 }, models: [] };
  const calls = [];
  const confirmations = [];
  let confirmed = true;
  let nextActionResponse;
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  let cursor = 0;
  let states = [];
  let plugin;
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      const instanceStates = states;
      return [instanceStates[index], value => { instanceStates[index] = typeof value === 'function' ? value(instanceStates[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = { current: initial };
      return states[index];
    },
    useCallback: fn => fn,
    useEffect() {},
  };
  const window = {
    __ModuleLoader__: { load: spec => { plugin = spec.factory(name => name === 'react' ? React : { slots: {} }); } },
    confirm: message => { confirmations.push(message); return confirmed; },
  };
  vm.runInNewContext(source, {
    window,
    localStorage: { getItem: () => null },
    fetch: async (url, options) => {
      if (options) {
        calls.push(JSON.parse(options.body));
        if (nextActionResponse) {
          const response = nextActionResponse;
          nextActionResponse = undefined;
          return response;
        }
      }
      return { ok: true, json: async () => options ? { ok: true } : data };
    },
    setTimeout() {}, setInterval() {}, clearInterval() {},
  });
  let Action;
  plugin.apply({ slots: { inject: (_name, fn) => fn(), register: (spec, component) => { if (spec.name === 'conversation.session.header.actions') Action = component; } } });
  cursor = 0;
  const actionTree = Action({ sessionId: 'session-test' });
  const Dialog = actionTree.children.find(node => typeof node?.type === 'function').type;
  states = ['board', data, data.config, false, '', '', {}];
  // Keep hooks local to each function-component instance, rather than appending
  // child hooks to the dialog's slots. Task identity survives order/epoch changes.
  const componentStates = new Map();
  function resolve(node, path = 'dialog') {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      const key = `${path}/${node.type.name}:${node.props.task?.id || node.props.key || ''}`;
      const parentStates = states, parentCursor = cursor;
      states = componentStates.get(key) || [];
      componentStates.set(key, states);
      cursor = 0;
      try {
        return resolve(node.type({ ...node.props, children: node.children }), key);
      } finally {
        states = parentStates;
        cursor = parentCursor;
      }
    }
    return { ...node, children: node.children.map((child, index) => resolve(child,
      `${path}/${child?.props?.key ?? index}`)) };
  }
  function render() {
    cursor = 0;
    return resolve(Dialog({ sessionId: 'session-test', isOpen: true, themeMode, onClose() {}, toggleTheme() {} }));
  }
  function nodes(tree = render()) {
    const result = [];
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      result.push(node);
      node.children?.forEach(visit);
    }
    visit(tree);
    return result;
  }
  const text = node => typeof node === 'object' && node ? node.children.map(text).join('') : typeof node === 'string' ? node : '';
  const button = label => nodes().find(node => node.type === 'button' && text(node).includes(label));
  return { data, calls, confirmations, render, nodes, text, button, flush,
    deferAction() { let release; nextActionResponse = new Promise(resolve => { release = resolve; }); return result => release({ ok: true, json: async () => result }); },
    setConfirmed: value => { confirmed = value; } };
}
const interruptedTask = overrides => ({ id: 'task-1', title: '实现恢复', status: 'needs_attention', waitingReason: 'INTERRUPTED', executionEpoch: 3, ...overrides });

test('pause stops new dispatch; resume restores only scheduling', async () => {
  const h = harness({ status: 'ready', tasks: [interruptedTask()] });
  await h.button('暂停批次').props.onClick();
  assert.equal(h.calls[0].action, 'pause');
  assert.match(h.text(h.render()), /不终止当前任务/);
  h.data.board.status = 'paused';
  await h.button('继续批次').props.onClick();
  assert.equal(h.calls[1].action, 'resume');
  assert.match(h.text(h.render()), /只恢复调度，不保证自动运行/);
  assert.match(h.text(h.render()), /未完成任务需主控继续派发/);
});

test('interrupt requires explicit confirmation and preserves cancel', async () => {
  const h = harness({ tasks: [interruptedTask()] });
  assert.ok(h.button('取消全部'));
  h.setConfirmed(false);
  await h.button('中断执行').props.onClick();
  assert.equal(h.calls.length, 0);
  assert.match(h.confirmations[0], /核查文件和测试/);
  h.setConfirmed(true);
  await h.button('中断执行').props.onClick();
  assert.equal(h.calls[0].action, 'interrupt');
});

test('one-click retryExecution needs no note or confirmation and reports request state', async () => {
  const h = harness({ tasks: [interruptedTask()] });
  assert.equal(h.nodes().filter(node => node.type === 'textarea').length, 0);
  assert.equal(h.button('恢复 / 重试').props.disabled, false);
  const release = h.deferAction();
  h.setConfirmed(false);
  h.button('恢复 / 重试').props.onClick();
  assert.deepEqual(h.calls[0], { sessionId: 'session-test', action: 'retryExecution', taskId: 'task-1' });
  assert.equal(h.confirmations.length, 0, 'one-click retry does not use the old recovery confirmation');
  assert.equal(h.button('恢复 / 重试').props.disabled, true);
  assert.match(h.text(h.render()), /正在提交…/);
  release({ ok: true }); await h.flush();
  assert.equal(h.button('恢复 / 重试').props.disabled, false);
  assert.match(h.text(h.render()), /已派发/);

  const reject = h.deferAction();
  h.button('恢复 / 重试').props.onClick();
  reject({ ok: false, error: '模型不可用' }); await h.flush();
  assert.match(h.text(h.render()), /操作失败：模型不可用/);
  assert.equal(h.button('恢复 / 重试').props.disabled, false);
});

test('retry limit keeps original explicit approval and excludes recovery input', async () => {
  const h = harness({ tasks: [interruptedTask({ waitingReason: 'RETRY_LIMIT_REACHED' })] });
  assert.equal(h.button('续做任务'), undefined);
  assert.equal(h.nodes().filter(node => node.type === 'textarea').length, 0);
  assert.equal(h.button('恢复 / 重试').props.disabled, true);
  assert.match(h.text(h.render()), /已达返工上限，请先授权继续返工/);
  h.setConfirmed(false);
  await h.button('允许继续返工').props.onClick();
  assert.equal(h.calls.length, 0);
  h.setConfirmed(true);
  await h.button('允许继续返工').props.onClick();
  assert.deepEqual(h.calls[0], { sessionId: 'session-test', action: 'retry', taskId: 'task-1', continueAfterLimit: true });
});

test('pending and needs_attention get shared execution controls; terminal and active tasks do not', () => {
  for (const status of ['pending', 'needs_attention', 'running', 'review', 'done', 'failed', 'cancelled']) {
    const h = harness({ tasks: [interruptedTask({ status, waitingReason: undefined })] });
    const controls = h.nodes().filter(node => node.props['data-task-execution-controls']);
    assert.equal(controls.length, ['pending', 'needs_attention'].includes(status) ? 1 : 0, status);
    if (controls.length) {
      assert.equal(h.button(status === 'pending' ? '执行 / 重试' : '恢复 / 重试').props.disabled, false);
      assert.ok(h.nodes().some(node => node.type === 'select' && node.props['aria-label'] === '任务 实现恢复 执行模型'));
    }
    assert.equal(h.nodes().filter(node => node.type === 'textarea').length, 0, status);
  }
});

test('recovery banner and structured checkpoint are honest in both themes', () => {
  for (const themeMode of ['light', 'dark']) {
    const h = harness({ themeMode, recovery: { interruptedAt: '2026-01-01T00:00:00Z', reason: 'HOST_RESTART' }, tasks: [interruptedTask({ checkpoint: { note: '编译待验证', updatedAt: '2026-01-02T00:00:00Z' } })] });
    const text = h.text(h.render());
    assert.match(text, /HOST_RESTART/);
    assert.match(text, /中断时间：/);
    assert.match(text, /尚未确认文件与测试状态/);
    assert.match(text, /不表示检查已完成/);
    assert.match(text, /编译待验证/);
    assert.match(text, /更新时间：/);
    assert.match(text, /执行版本：3/);
    assert.doesNotMatch(text, /\[object Object\]/);
  }
});

test('recovery banner remains visible for an empty task board', () => {
  const h = harness({ recovery: { interruptedAt: '2026-01-01T00:00:00Z', reason: 'RESTART' } });
  assert.match(h.text(h.render()), /恢复提示/);
  assert.match(h.text(h.render()), /当前任务板暂无任务/);
});

test('shared execution busy and notices are isolated by task during model selection and retry', async () => {
  const h = harness({ tasks: [interruptedTask(), interruptedTask({ id: 'task-2' })] });
  const controls = () => h.nodes().filter(node => node.props['data-task-execution-controls']);
  const taskButton = control => h.nodes(control).find(node => node.type === 'button');
  let release = h.deferAction();
  h.nodes(controls()[0]).find(node => node.type === 'select').props.onChange({ target: { value: JSON.stringify(['provider-a', 'model-a']) } });
  assert.deepEqual(h.calls[0], { sessionId: 'session-test', action: 'selectTaskModel', taskId: 'task-1', provider: 'provider-a', model: 'model-a' });
  assert.deepEqual(controls().map(control => taskButton(control).props.disabled), [true, false]);
  assert.match(h.text(controls()[0]), /正在提交…/);
  assert.doesNotMatch(h.text(controls()[1]), /正在提交…|模型已保存/);
  release({ ok: true }); await h.flush();
  assert.match(h.text(controls()[0]), /模型已保存/);
  assert.doesNotMatch(h.text(controls()[1]), /模型已保存/);

  release = h.deferAction();
  taskButton(controls()[1]).props.onClick();
  assert.deepEqual(h.calls[1], { sessionId: 'session-test', action: 'retryExecution', taskId: 'task-2' });
  assert.deepEqual(controls().map(control => taskButton(control).props.disabled), [false, true]);
  h.data.board.tasks.reverse();
  assert.deepEqual(controls().map(control => taskButton(control).props.disabled), [true, false], 'hook state follows task keys, not sibling position');
  release({ ok: false, error: '第二项失败' }); await h.flush();
  assert.match(h.text(controls()[0]), /操作失败：第二项失败/);
  assert.doesNotMatch(h.text(controls()[1]), /第二项失败/);
  assert.match(h.text(controls()[1]), /模型已保存/);
});

test('recovery banner honest rendering for shutdown condition', () => {
  const h = harness({ recovery: { interruptedAt: '2026-03-30T18:00:00Z', reason: 'SHUTDOWN' }, tasks: [interruptedTask({ title: '下班前任务' })] });
  const text = h.text(h.render());
  assert.match(text, /SHUTDOWN/);
  assert.match(text, /中断时间：/);
  assert.match(text, /恢复提示/);
});
