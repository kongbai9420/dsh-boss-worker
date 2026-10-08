window.__ModuleLoader__.load({
  id: 'dsh-lead-worker',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { slots } = require('@deepseek-ai/dsh-client-ui-slots');
    let createPortal;
    try { createPortal = require('react-dom').createPortal; } catch {}
    const floatingPortal = element => typeof createPortal === 'function' && typeof document !== 'undefined' && document.body ? createPortal(element, document.body) : element;

    // 双模式主题调色板（支持自动跟随系统/DSH主题，也支持手动切换日间/暗黑模式）
    const THEMES = {
      light: {
        id: 'light',
        isDark: false,
        bgOverlay: 'rgba(0, 0, 0, 0.28)',
        bgWindow: '#ffffff',
        borderWindow: 'rgba(0, 0, 0, 0.12)',
        shadowWindow: '0 20px 50px rgba(0, 0, 0, 0.18), 0 0 1px rgba(0, 0, 0, 0.2)',
        bgTitleBar: '#f5f5f7',
        borderTitleBar: 'rgba(0, 0, 0, 0.08)',
        textTitle: '#1d1d1f',
        bgTabContainer: '#f0f0f2',
        borderTabContainer: 'rgba(0, 0, 0, 0.08)',
        bgSegmentCtrl: 'rgba(0, 0, 0, 0.06)',
        bgSegmentActive: '#ffffff',
        textSegmentActive: '#0071e3',
        textSegmentInactive: '#6e6e73',
        shadowSegmentActive: '0 2px 6px rgba(0,0,0,0.1)',
        bgBody: '#fafafc',
        textPrimary: '#1d1d1f',
        textSecondary: '#6e6e73',
        textTertiary: '#86868b',
        bgCard: '#ffffff',
        borderCard: 'rgba(0, 0, 0, 0.08)',
        shadowCard: '0 1px 3px rgba(0,0,0,0.04)',
        bgRowHover: '#f5f5f7',
        borderRow: 'rgba(0, 0, 0, 0.06)',
        bgInput: '#ffffff',
        borderInput: '#d2d2d7',
        textInput: '#1d1d1f',
        bgSelect: '#ffffff',
        borderSelect: '#d2d2d7',
        textSelect: '#1d1d1f',
        bgTextarea: '#ffffff',
        borderTextarea: '#d2d2d7',
        textTextarea: '#1d1d1f',
        btnSecondaryBg: '#ffffff',
        btnSecondaryText: '#1d1d1f',
        btnSecondaryBorder: '#d2d2d7',
        btnSecondaryHover: '#f5f5f7',
        pillBgDefault: 'rgba(0, 0, 0, 0.06)',
        pillTextDefault: '#6e6e73',
        triggerBtnBg: '#ffffff',
        triggerBtnText: '#1d1d1f',
        triggerBtnBorder: 'rgba(0, 0, 0, 0.15)',
        triggerBtnShadow: '0 1px 2px rgba(0,0,0,0.05)',
      },
      dark: {
        id: 'dark',
        isDark: true,
        bgOverlay: 'rgba(0, 0, 0, 0.65)',
        bgWindow: '#1e1e20',
        borderWindow: 'rgba(255, 255, 255, 0.16)',
        shadowWindow: '0 24px 60px rgba(0, 0, 0, 0.75), 0 0 1px rgba(255, 255, 255, 0.25) inset',
        bgTitleBar: '#252528',
        borderTitleBar: 'rgba(255, 255, 255, 0.1)',
        textTitle: '#ffffff',
        bgTabContainer: '#28282b',
        borderTabContainer: 'rgba(255, 255, 255, 0.08)',
        bgSegmentCtrl: 'rgba(0, 0, 0, 0.35)',
        bgSegmentActive: '#0071e3',
        textSegmentActive: '#ffffff',
        textSegmentInactive: 'rgba(255, 255, 255, 0.7)',
        shadowSegmentActive: '0 2px 8px rgba(0, 113, 227, 0.4)',
        bgBody: '#1e1e20',
        textPrimary: '#ffffff',
        textSecondary: 'rgba(255, 255, 255, 0.85)',
        textTertiary: 'rgba(255, 255, 255, 0.6)',
        bgCard: '#28282b',
        borderCard: 'rgba(255, 255, 255, 0.1)',
        shadowCard: 'none',
        bgRowHover: '#323236',
        borderRow: 'rgba(255, 255, 255, 0.06)',
        bgInput: '#18181a',
        borderInput: 'rgba(255, 255, 255, 0.18)',
        textInput: '#ffffff',
        bgSelect: '#18181a',
        borderSelect: 'rgba(255, 255, 255, 0.18)',
        textSelect: '#ffffff',
        bgTextarea: '#18181a',
        borderTextarea: 'rgba(255, 255, 255, 0.18)',
        textTextarea: '#ffffff',
        btnSecondaryBg: 'rgba(255, 255, 255, 0.1)',
        btnSecondaryText: '#ffffff',
        btnSecondaryBorder: 'rgba(255, 255, 255, 0.15)',
        btnSecondaryHover: 'rgba(255, 255, 255, 0.16)',
        pillBgDefault: 'rgba(255, 255, 255, 0.1)',
        pillTextDefault: '#c7c7cc',
        triggerBtnBg: '#2a2a2d',
        triggerBtnText: '#ffffff',
        triggerBtnBorder: 'rgba(255, 255, 255, 0.18)',
        triggerBtnShadow: '0 1px 2px rgba(0,0,0,0.3)',
      }
    };

    function getInitialTheme() {
      try {
        const saved = localStorage.getItem('dsh_lead_worker_theme');
        if (saved === 'light' || saved === 'dark') return saved;
      } catch {}
      // 检查当前页面 body 或系统是否为亮色
      if (typeof window !== 'undefined') {
        const isSystemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        return isSystemDark ? 'dark' : 'light';
      }
      return 'light';
    }

    const STATUS_CONFIG = {
      draft: { text: '就绪 / 待起草', colorLight: '#6e6e73', bgLight: 'rgba(0,0,0,0.06)', colorDark: '#c7c7cc', bgDark: 'rgba(255,255,255,0.12)' },
      ready: { text: '已规划 / 派发中', colorLight: '#0071e3', bgLight: 'rgba(0,113,227,0.12)', colorDark: '#64d2ff', bgDark: 'rgba(100,210,255,0.2)' },
      paused: { text: '已暂停派发', colorLight: '#b25e00', bgLight: 'rgba(255,149,0,0.15)', colorDark: '#ffd60a', bgDark: 'rgba(255,214,10,0.2)' },
      cancelled: { text: '已取消全部', colorLight: '#d70015', bgLight: 'rgba(255,59,48,0.12)', colorDark: '#ff453a', bgDark: 'rgba(255,69,58,0.2)' }
    };

    const TASK_STATUS_CONFIG = {
      pending: { text: '待执行', colorLight: '#6e6e73', bgLight: 'rgba(0,0,0,0.06)', colorDark: '#c7c7cc', bgDark: 'rgba(255,255,255,0.1)' },
      running: { text: '正在执行中...', colorLight: '#0071e3', bgLight: 'rgba(0,113,227,0.12)', colorDark: '#64d2ff', bgDark: 'rgba(100,210,255,0.22)' },
      review: { text: '待主控审查验收', colorLight: '#b25e00', bgLight: 'rgba(255,149,0,0.15)', colorDark: '#ffd60a', bgDark: 'rgba(255,214,10,0.22)' },
      done: { text: '已通过验收', colorLight: '#248a3d', bgLight: 'rgba(52,199,89,0.15)', colorDark: '#30d158', bgDark: 'rgba(48,209,88,0.22)' },
      failed: { text: '执行失败', colorLight: '#d70015', bgLight: 'rgba(255,59,48,0.12)', colorDark: '#ff453a', bgDark: 'rgba(255,69,58,0.22)' },
      needs_attention: { text: '需人工介入/重试', colorLight: '#b25e00', bgLight: 'rgba(255,149,0,0.15)', colorDark: '#ff9f0a', bgDark: 'rgba(255,159,10,0.22)' },
      cancelled: { text: '已取消', colorLight: '#86868b', bgLight: 'rgba(0,0,0,0.04)', colorDark: '#8e8e93', bgDark: 'rgba(255,255,255,0.08)' },
    };

    // One read-only view stream per exact session, shared by both registered entries.
    const viewStreams = new Map();
    function subscribeView(sessionId, interval, listener) {
      if (typeof sessionId !== 'string' || !sessionId) return () => {};
      let stream = viewStreams.get(sessionId);
      if (!stream) {
        stream = { listeners: new Map(), snapshot: { sessionId, data: null, updatedAt: null, error: '', syncing: false }, timer: null, pending: null, queuedRefresh: false, active: true };
        viewStreams.set(sessionId, stream);
        stream.emit = () => { for (const fn of stream.listeners.keys()) fn(stream.snapshot); };
        stream.schedule = (immediate = false) => {
          clearTimeout(stream.timer);
          stream.timer = null;
          if (!stream.active || !stream.listeners.size || (typeof document !== 'undefined' && document.hidden)) return;
          const delay = immediate ? 0 : Math.min(...stream.listeners.values());
          stream.timer = setTimeout(() => stream.refresh(false), delay);
        };
        stream.refresh = (queueIfPending = true) => {
          if (!stream.active || !stream.listeners.size || (typeof document !== 'undefined' && document.hidden)) return Promise.resolve();
          if (stream.pending) {
            // A mutation/open refresh must not reuse a GET started before it.
            if (queueIfPending) stream.queuedRefresh = true;
            return stream.pending;
          }
          clearTimeout(stream.timer);
          stream.timer = null;
          stream.snapshot = { ...stream.snapshot, syncing: true };
          stream.emit();
          const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
          stream.controller = controller;
          let timeout;
          const request = async () => {
            const res = await fetch(`/api/lead-worker/view?sessionId=${encodeURIComponent(sessionId)}`, controller ? { signal: controller.signal } : undefined);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
          };
          stream.pending = (async () => {
            try {
              const data = await Promise.race([request(), new Promise((_, reject) => { timeout = setTimeout(() => { controller?.abort(); reject(new Error('同步超时')); }, 15000); })]);
              if (!data.ok) throw new Error(data.error || '同步失败');
              if (data.sessionId != null && data.sessionId !== sessionId) throw new Error('会话标识不匹配');
              if (stream.active && !stream.queuedRefresh) stream.snapshot = { sessionId, data, updatedAt: Date.now(), error: '', syncing: false };
            } catch (err) {
              if (stream.active && !stream.queuedRefresh) stream.snapshot = { ...stream.snapshot, error: err.message || '同步失败', syncing: false };
            } finally {
              clearTimeout(timeout);
              stream.controller = null;
              stream.pending = null;
              const refreshAgain = stream.queuedRefresh;
              stream.queuedRefresh = false;
              if (stream.active && stream.listeners.size) {
                if (refreshAgain && !(typeof document !== 'undefined' && document.hidden)) {
                  return stream.refresh();
                }
                stream.emit(); stream.schedule();
              }
            }
          })();
          return stream.pending;
        };
        stream.visibility = () => {
          stream.emit();
          stream.schedule(true);
        };
        if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', stream.visibility);
      }
      stream.listeners.set(listener, interval);
      listener(stream.snapshot);
      stream.schedule(!stream.snapshot.updatedAt);
      return () => {
        stream.listeners.delete(listener);
        if (stream.listeners.size) { stream.schedule(); return; }
        clearTimeout(stream.timer);
        // React may immediately re-subscribe with a new cadence. Keep that stream
        // and its pending request; tear down only after the effect transition.
        Promise.resolve().then(() => {
          if (stream.listeners.size) return;
          stream.active = false;
          stream.controller?.abort();
          clearTimeout(stream.timer);
          if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', stream.visibility);
          if (viewStreams.get(sessionId) === stream) viewStreams.delete(sessionId);
        });
      };
    }
    const FLOAT_PREF_KEY = 'dsh_lead_worker_floating_v1';
    const floatingEntries = new Map();
    let sharedFloatingPrefs;
    function notifyFloatingEntries() {
      const ownedSessions = new Set();
      for (const [key, entry] of floatingEntries) {
        entry.setOwner(!ownedSessions.has(entry.sessionId));
        ownedSessions.add(entry.sessionId);
        entry.setPrefs(sharedFloatingPrefs);
      }
    }
    function floatingPreferences() {
      try {
        const value = JSON.parse(localStorage.getItem(FLOAT_PREF_KEY) || '{}');
        return { visible: value.visible !== false, collapsed: true, x: Number.isFinite(value.x) ? value.x : 12, y: Number.isFinite(value.y) ? value.y : 80, cardWidth: Number.isFinite(value.cardWidth) ? value.cardWidth : 410, cardHeight: Number.isFinite(value.cardHeight) ? value.cardHeight : 620, cardX: Number.isFinite(value.cardX) ? value.cardX : undefined, cardY: Number.isFinite(value.cardY) ? value.cardY : undefined };
      } catch { return { visible: true, collapsed: true, x: 12, y: 80, cardWidth: 410, cardHeight: 620 }; }
    }
    function constrainFloating(value) {
      const width = Math.max(0, window.innerWidth || 1024);
      const height = Math.max(0, window.innerHeight || 768);
      // Persist the ball anchor, not the card size, so expanding never loses its dock.
      const barWidth = Math.min(Math.max(180, width - 16), 260), barHeight = 34;
      return { ...value, x: Math.min(Math.max(0, value.x), Math.max(0, width - barWidth)), y: Math.min(Math.max(0, value.y), Math.max(0, height - barHeight)) };
    }
    function dockFloating(value) {
      const width = Math.max(0, window.innerWidth || 1024);
      const barWidth = Math.min(Math.max(180, width - 16), 260);
       const inset = Math.min(12, Math.max(0, (width - barWidth) / 2));
      return constrainFloating({ ...value, x: value.x + barWidth / 2 < width / 2 ? inset : Math.max(0, width - barWidth - inset) });
    }
    function recordText(value) {
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    }
    function taskElapsed(task, now) {
      const history = Array.isArray(task.executionHistory) ? task.executionHistory : [];
      let index = -1;
      for (let i = history.length - 1; i >= 0; i--) if (history[i].status === 'started') { index = i; break; }
      if (index < 0) return '暂无耗时数据';
      const start = Date.parse(history[index].at);
      const terminal = history.slice(index + 1).find(record => (record.status === 'review' || record.status === 'interrupted') && record.epoch === history[index].epoch);
      const end = terminal ? Date.parse(terminal.at) : task.status === 'running' ? now : NaN;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '暂无耗时数据';
      const seconds = Math.floor((end - start) / 1000);
      return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
    }
    const BOSS_DIRECT_RULES = '【👑 BOSS直派规则】: 无论是单任务还是多任务、不论需求大小，严禁主模型亲自编写实现代码或在工作区执行修改！所有具体代码实现、命令执行、测试验证必须先分配并派发给子模型（如 Sol、QA 等）干活；主模型只负责检查、审查与把关验收这些主控规则。';
    function syncBossPrompt(prompt = '', bossDirect = false) {
      const cleaned = (prompt || '').replace(/【👑 BOSS直派规则】:[^\n]*\n?/g, '').trim();
      if (!bossDirect) return cleaned;
      return `${BOSS_DIRECT_RULES}\n${cleaned}`.trim();
    }
    function isBossDirectActive(config) {
      // A persisted config value is authoritative. Local storage is only a legacy
      // fallback when the host has not supplied the field yet.
      if (typeof config?.bossDirect === 'boolean') return config.bossDirect;
      if (config?.leadPrompt && config.leadPrompt.includes('BOSS直派')) return true;
      try { return typeof localStorage !== 'undefined' && localStorage.getItem('dsh_boss_direct_mode') === 'true'; } catch { return false; }
    }
    function TaskExecutionControls({ sessionId, task, data }) {
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const [note, setNote] = React.useState('');
      const act = async (action, params = {}) => {
        setBusy(true); setNotice('正在提交…');
        try {
          const res = await fetch('/api/lead-worker/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, action, taskId: task.id, ...params }) });
          const result = await res.json();
          if (!result.ok) throw new Error(result.error || `HTTP ${res.status}`);
          setNotice(action === 'selectTaskModel' ? '模型已保存' : action === 'recoverTask' ? '已恢复待执行，请选择模型并派发' : '已派发');
          viewStreams.get(sessionId)?.refresh?.();
        } catch (err) { setNotice(`操作失败：${err.message}`); }
        finally { setBusy(false); }
      };
      if (!['pending', 'needs_attention'].includes(task.status)) return null;
      const member = data?.config?.members?.find(m => m.id === task.memberId);
      const blocked = !['ready', 'paused'].includes(data?.board?.status) ? '任务板正在停工或已结束' : '';
      return React.createElement('div', { 'data-task-execution-controls': true, style: { margin: '10px 0', padding: 12, borderRadius: 12, border: '1px solid rgba(128,140,160,0.24)', background: 'rgba(128,140,160,0.06)', fontSize: 11, display: 'grid', gap: 8 } },
        React.createElement('label', null, '本任务执行模型：', React.createElement('select', {
          'aria-label': `任务 ${task.title} 执行模型`, disabled: busy,
          value: JSON.stringify([member?.provider || '', member?.model || '']),
          onChange: e => { const [provider, model] = JSON.parse(e.target.value); act('selectTaskModel', { provider, model }); },
          style: { width: '100%', boxSizing: 'border-box', marginTop: 6, padding: '9px 12px', borderRadius: 9, border: '1px solid rgba(128,140,160,0.32)', background: '#eef2f8', color: '#26344a', fontSize: 12, cursor: 'pointer', outlineOffset: 2 }
        }, React.createElement('option', { value: JSON.stringify(['', '']), disabled: true }, '请选择模型'),
        data?.models?.map(m => React.createElement('option', { key: `${m.provider}/${m.model}`, value: JSON.stringify([m.provider, m.model]) }, m.name || `${m.provider}/${m.model}`)))),
        React.createElement('button', { type: 'button', style: { padding: '9px 14px', borderRadius: 9, border: '1px solid #438afa', background: busy ? '#7185a5' : 'linear-gradient(135deg, #2979ed, #4263dd)', color: '#fff', fontSize: 12, fontWeight: 600, boxShadow: '0 3px 8px rgba(41,121,237,0.18)', cursor: busy ? 'wait' : 'pointer' }, disabled: busy || task.waitingReason === 'RETRY_LIMIT_REACHED',
          onClick: () => { if (blocked) { setNotice(blocked); return; } act('retryExecution'); }
        }, task.status === 'pending' ? '执行 / 重试' : '恢复 / 重试'),
        blocked && React.createElement('div', { role: 'status' }, blocked),
        task.waitingReason === 'RETRY_LIMIT_REACHED' && React.createElement('div', null, '已达返工上限，请先授权继续返工'),
        notice && React.createElement('div', { role: 'status' }, notice));
    }
    async function toggleBossDirectQuick(sessionId, currentConfig, onSuccess, onError) {
      try {
        const latest = await (await fetch(`/api/lead-worker/view?sessionId=${encodeURIComponent(sessionId)}`)).json();
        if (!latest.ok) throw new Error(latest.error || '无法读取最新配置');
        const nextBossDirect = !isBossDirectActive(latest.config);
        const nextPrompt = syncBossPrompt(latest.config.leadPrompt || '', nextBossDirect);
        const nextConfig = { ...latest.config, bossDirect: nextBossDirect, leadPrompt: nextPrompt };
        
        let res = await fetch('/api/lead-worker/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, action: 'configureSession', bossDirect: nextBossDirect, expectedConfigRevision: latest.configRevision }),
        });
        let result = await res.json();
        if (!result.ok && result.error && result.error.includes('unknown field bossDirect')) {
          const fallbackCfg = { ...nextConfig };
          delete fallbackCfg.bossDirect;
          res = await fetch('/api/lead-worker/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, action: 'configure', config: fallbackCfg }),
          });
          result = await res.json();
        }
        if (!result.ok) throw new Error(result.error || '切换失败');
        viewStreams.get(sessionId)?.refresh?.();
        onSuccess?.(nextBossDirect, nextConfig);
      } catch (err) {
        onError?.(err);
      }
    }
    function FloatingTaskMonitor({ sessionId, monitor, prefs, setPrefs, themeMode, toggleTheme, onOpen }) {
      const [drag, setDrag] = React.useState(null);
      const [gesture] = React.useState(() => ({ suppressClick: false }));
      const [resize, setResize] = React.useState(null);
      const cardPosRef = React.useRef(null);
      const startDrag = event => {
        if (event.button != null && event.button !== 0) return;
        event.preventDefault?.();
        event.stopPropagation?.();
        // Pointer down on the drag handle must never initiate text selection.
        window.getSelection?.()?.removeAllRanges?.();
        gesture.suppressClick = false;
        setDrag({ id: event.pointerId, startX: event.clientX, startY: event.clientY, x: prefs.x, y: prefs.y, moved: false });
      };
      const toggleCollapsed = event => {
        if (gesture.suppressClick && event?.detail !== 0) { gesture.suppressClick = false; return; }
        gesture.suppressClick = false;
        setPrefs(prev => constrainFloating({ ...prev, collapsed: !prev.collapsed }));
      };
      React.useEffect(() => {
        if (prefs.collapsed || typeof document === 'undefined') return;
        const closeOutside = event => {
          const target = event?.target;
          if (target?.closest?.('[data-floating-status-bar], [data-floating-card]')) return;
          if (gesture.suppressClick) return;
          setPrefs(prev => ({ ...prev, collapsed: true }));
        };
        document.addEventListener?.('pointerdown', closeOutside, true);
        return () => document.removeEventListener?.('pointerdown', closeOutside, true);
      }, [prefs.collapsed, setPrefs]);
      React.useEffect(() => {
        const resize = () => setPrefs(prev => constrainFloating(prev));
        window.addEventListener?.('resize', resize);
        resize();
        return () => window.removeEventListener?.('resize', resize);
      }, [prefs.collapsed, setPrefs]);
      React.useEffect(() => {
        if (!drag) return;
        const body = typeof document !== 'undefined' ? document.body : null;
        const previousUserSelect = body?.style?.userSelect;
        const previousWebkitUserSelect = body?.style?.webkitUserSelect;
        if (body?.style) { body.style.userSelect = 'none'; body.style.webkitUserSelect = 'none'; }
        const blockSelection = event => event.preventDefault?.();
        if (typeof document !== 'undefined') document.addEventListener?.('selectstart', blockSelection);
        const move = event => {
          if (event.pointerId !== drag.id) return;
          event.preventDefault?.();
          const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
          if (!drag.moved && Math.hypot(dx, dy) <= 5) return;
          drag.moved = true;
          gesture.suppressClick = true;
          setPrefs(prev => constrainFloating({ ...prev, x: drag.x + dx, y: drag.y + dy, cardX: undefined, cardY: undefined }));
        };
        const stop = event => {
          if (event.pointerId !== drag.id) return;
          // Keep the exact dragged position; no edge snapping.
          setDrag(null);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
        return () => {
          window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop);
          if (typeof document !== 'undefined') document.removeEventListener?.('selectstart', blockSelection);
          if (body?.style) { body.style.userSelect = previousUserSelect || ''; body.style.webkitUserSelect = previousWebkitUserSelect || ''; }
        };
      }, [drag, setPrefs]);
      const MIN_CARD_WIDTH = 280, MIN_CARD_HEIGHT = 360;
      const startResize = (dir, event) => {
        if (event.button != null && event.button !== 0) return;
        event.preventDefault?.();
        event.stopPropagation?.();
        window.getSelection?.()?.removeAllRanges?.();
        const pos = cardPosRef.current || {};
        setResize({
          id: event.pointerId,
          dir,
          startX: event.clientX,
          startY: event.clientY,
          origX: Number.isFinite(pos.x) ? pos.x : 12,
          origY: Number.isFinite(pos.y) ? pos.y : 80,
          origW: pos.width || prefs.cardWidth || 410,
          origH: pos.height || prefs.cardHeight || 620
        });
      };
      React.useEffect(() => {
        if (!resize) return;
        const body = typeof document !== 'undefined' ? document.body : null;
        const previousUserSelect = body?.style?.userSelect;
        const previousWebkitUserSelect = body?.style?.webkitUserSelect;
        if (body?.style) { body.style.userSelect = 'none'; body.style.webkitUserSelect = 'none'; }
        const blockSelection = event => event.preventDefault?.();
        if (typeof document !== 'undefined') document.addEventListener?.('selectstart', blockSelection);
        const move = event => {
          if (event.pointerId !== resize.id) return;
          event.preventDefault?.();
          const dx = event.clientX - resize.startX, dy = event.clientY - resize.startY;
          const maxW = Math.max(MIN_CARD_WIDTH, window.innerWidth || 1024);
          const maxH = Math.max(MIN_CARD_HEIGHT, window.innerHeight || 768);
          let newX = resize.origX;
          let newY = resize.origY;
          let newW = resize.origW;
          let newH = resize.origH;

          // 左右与四个角的宽度计算
          if (resize.dir.includes('e')) {
            newW = Math.min(Math.max(resize.origW + dx, MIN_CARD_WIDTH), maxW - resize.origX);
          } else if (resize.dir.includes('w')) {
            const rawW = resize.origW - dx;
            const clampedW = Math.min(Math.max(rawW, MIN_CARD_WIDTH), resize.origX + resize.origW);
            newX = resize.origX + (resize.origW - clampedW);
            newW = clampedW;
          }

          // 上下与四个角的高度计算
          if (resize.dir.includes('s')) {
            newH = Math.min(Math.max(resize.origH + dy, MIN_CARD_HEIGHT), maxH - resize.origY);
          } else if (resize.dir.includes('n')) {
            const rawH = resize.origH - dy;
            const clampedH = Math.min(Math.max(rawH, MIN_CARD_HEIGHT), resize.origY + resize.origH);
            newY = resize.origY + (resize.origH - clampedH);
            newH = clampedH;
          }

          setPrefs(prev => ({
            ...prev,
            cardX: Math.max(0, Math.min(newX, maxW - newW)),
            cardY: Math.max(0, Math.min(newY, maxH - newH)),
            cardWidth: Math.max(MIN_CARD_WIDTH, newW),
            cardHeight: Math.max(MIN_CARD_HEIGHT, newH)
          }));
        };
        const stop = event => {
          if (event.pointerId !== resize.id) return;
          setResize(null);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
        return () => {
          window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop);
          if (typeof document !== 'undefined') document.removeEventListener?.('selectstart', blockSelection);
          if (body?.style) { body.style.userSelect = previousUserSelect || ''; body.style.webkitUserSelect = previousWebkitUserSelect || ''; }
        };
      }, [resize, setPrefs]);
      const t = THEMES[themeMode] || THEMES.light;
      const current = monitor?.sessionId === sessionId ? monitor : null;
      const data = current?.data;
      const tasks = data?.board?.tasks || [];
      const buttonStyle = { border: `1px solid ${t.borderRow}`, background: 'transparent', color: t.textSecondary, borderRadius: '8px', padding: '5px 8px', cursor: 'pointer', fontSize: '11px', flexShrink: 0 };
      const button = (label, onClick) => React.createElement('button', { type: 'button', style: buttonStyle, onClick, onPointerDown: event => event.stopPropagation() }, label);
      const hidden = typeof document !== 'undefined' && document.hidden;
      const syncText = !sessionId ? '请选择当前会话' : current?.error ? `同步失败：${current.error}（以下为旧快照，非实时）` : hidden ? '页面隐藏，已停止同步（快照非实时）' : !current?.updatedAt ? '正在同步，尚无任务快照' : current.syncing ? '正在同步（显示上次快照）' : '自动同步 · 只读监控';
      const counts = { done: 0, running: 0, review: 0, pending: 0, attention: 0 };
      tasks.forEach(task => { if (task.status in counts) counts[task.status]++; if (task.status === 'needs_attention' || task.status === 'failed') counts.attention++; });
      const isDraining = Boolean(data?.board?.status === 'draining' || (data?.board?.status === 'paused' && counts.running > 0));
      const state = current?.error || tasks.some(task => task.status === 'failed') ? 'error' : counts.review || counts.attention || data?.board?.status === 'paused' ? 'attention' : counts.running ? 'running' : tasks.length && counts.done === tasks.length ? 'done' : 'pending';
      const ballColors = { running: '#0071e3', attention: '#ff9500', done: '#248a3d', pending: '#6e6e73', error: '#d70015' };
      const statusCellConfig = {
        running: { label: '⚡ 运行中', bg: '#1674ed', border: '1px solid #70b5ff', labelColor: '#ffffff', valueColor: '#ffffff' },
        review: { label: '🔍 审计中', bg: '#ffb020', border: '1px solid #ffda80', labelColor: '#302000', valueColor: '#302000' },
        pending: { label: '⏳ 待执行', bg: '#8650e8', border: '1px solid #c4a2ff', labelColor: '#ffffff', valueColor: '#ffffff' },
      };
      const stateLabels = { running: '执行中', attention: '待审查 / 需介入', done: '全部已验收', pending: !sessionId ? '请选择会话' : !data ? '正在同步' : !tasks.length ? '暂无任务' : '等待执行', error: '警示：同步或任务失败' };
      const position = constrainFloating(prefs);
      const floatingWidth = Math.min(Math.max(180, (window.innerWidth || 1024) - 16), 260);
      const statusCell = (type, count) => {
        const active = Boolean(data && count > 0);
        const conf = active ? statusCellConfig[type] : {
          ...statusCellConfig[type], bg: '#292d34',
          border: '1px solid #414751', labelColor: '#959ca7', valueColor: '#959ca7'
        };
        return React.createElement('span', {
          key: type,
          'data-status-cell': type,
          'data-active': active,
          style: {
            minWidth: 0,
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            padding: '3px 4px',
            borderRadius: 7,
            background: conf.bg,
            border: conf.border,
            boxShadow: active ? `0 0 10px ${conf.bg}88, inset 0 1px 0 rgba(255,255,255,0.22)` : 'none',
            whiteSpace: 'nowrap',
          }
        },
          React.createElement('strong', {
            style: { fontSize: 9, lineHeight: '11px', fontWeight: 600, color: conf.labelColor, letterSpacing: '-0.2px' }
          }, conf.label),
          React.createElement('span', {
            style: { fontSize: 13, lineHeight: '15px', fontWeight: 700, color: conf.valueColor }
          }, data ? count : '—')
        );
      };
      // Keep this keyed ball in the same Fragment slot in both modes. The card is
      // a sibling, never a replacement or a second collapse control.
      const ball = React.createElement('button', {
        key: 'task-ball', type: 'button', 'aria-label': `任务状态：运行 ${counts.running}，审计 ${counts.review}，待执行 ${counts.pending + counts.attention}，点击${prefs.collapsed ? '展开' : '收起'}任务监控`, 'aria-expanded': !prefs.collapsed, 'data-floating-status-bar': true,
        title: `${stateLabels[state]} · 运行 ${counts.running} · 审计 ${counts.review} · 待执行 ${counts.pending + counts.attention} · 已验收 ${counts.done}/${tasks.length} · 点击${prefs.collapsed ? '展开' : '收起'}任务监控${current?.error ? ` · 同步失败：${current.error}（旧快照，非实时）` : ''}`, 
        'data-state': state, onPointerDown: startDrag, onClick: toggleCollapsed,
        style: { position: 'fixed', zIndex: 9998, left: position.x, top: position.y, width: floatingWidth, minHeight: 38, maxWidth: 'calc(100vw - 16px)', borderRadius: 12, border: state === 'error' ? '1px solid rgba(215, 0, 21, 0.65)' : '1px solid rgba(255, 255, 255, 0.14)', background: 'rgba(20, 24, 33, 0.95)', color: '#fff', boxShadow: '0 4px 16px rgba(0,0,0,0.24), 0 1px 3px rgba(0,0,0,0.12)', cursor: drag ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none', display: 'flex', alignItems: 'stretch', justifyContent: 'stretch', gap: 3, padding: 3, overflow: 'hidden', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif' }
      }, statusCell('running', counts.running), statusCell('review', counts.review), statusCell('pending', counts.pending + counts.attention));
      const viewportWidth = Math.max(0, window.innerWidth || 1024), viewportHeight = Math.max(0, window.innerHeight || 768);
      const gap = 8, rightSpace = Math.max(0, viewportWidth - position.x - floatingWidth - gap), leftSpace = Math.max(0, position.x - gap);
      let cardWidth = Math.min(Math.max(prefs.cardWidth || 410, MIN_CARD_WIDTH), viewportWidth);
      let cardHeight = Math.min(Math.max(prefs.cardHeight || 620, MIN_CARD_HEIGHT), viewportHeight);
      let cardX, cardY;

      // 如果用户有明确调整并保存的绝对坐标，优先使用持久化布局，并保证在当前视口内安全可见
      if (Number.isFinite(prefs.cardX) && Number.isFinite(prefs.cardY)) {
        cardX = Math.max(0, Math.min(prefs.cardX, Math.max(0, viewportWidth - cardWidth)));
        cardY = Math.max(0, Math.min(prefs.cardY, Math.max(0, viewportHeight - cardHeight)));
      } else {
        cardY = Math.max(0, Math.min(position.y, Math.max(0, viewportHeight - cardHeight)));
        if (rightSpace >= cardWidth) cardX = position.x + floatingWidth + gap;
        else if (leftSpace >= cardWidth) cardX = position.x - gap - cardWidth;
        else if (Math.max(rightSpace, leftSpace) >= 180) {
          // Narrow the card on the roomier side, keeping the 56px ball clear.
          const right = rightSpace >= leftSpace;
          cardWidth = Math.min(cardWidth, right ? rightSpace : leftSpace);
          cardX = right ? position.x + floatingWidth + gap : position.x - gap - cardWidth;
        } else {
          // Phone-sized viewports cannot fit two columns: use the free vertical
          // side and clamp both dimensions. The ball stays above the card in z-order.
          const below = Math.max(0, viewportHeight - position.y - 48 - gap), above = Math.max(0, position.y - gap);
          cardHeight = Math.min(cardHeight, Math.max(below, above));
          cardX = Math.min(position.x, Math.max(0, viewportWidth - cardWidth));
          cardY = below >= above ? Math.min(viewportHeight, position.y + 48 + gap) : position.y - gap - cardHeight;
        }
      }
      cardPosRef.current = { x: cardX, y: cardY, width: cardWidth, height: cardHeight };
      const accent = t.isDark ? '#a7bfff' : '#335dc6';
      const mutedSurface = t.isDark ? '#25262b' : '#f5f6f8';
      const compact = cardHeight < 360;
      const detailText = value => value == null || value === '' ? '暂无记录' : recordText(value);
      const detailLine = (label, value) => React.createElement('div', { style: { marginTop: 6 } }, React.createElement('div', { style: { fontSize: 10, color: t.textTertiary, marginBottom: 2 } }, label), React.createElement('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: t.textSecondary } }, detailText(value)));
      const detailSection = (label, ...children) => React.createElement('section', { 'data-detail-section': label, style: { padding: '10px 0', borderTop: `1px solid ${t.borderRow}` } }, React.createElement('strong', { style: { fontSize: 11, color: t.textPrimary } }, label), ...children);
      const card = !prefs.collapsed && React.createElement('section', { key: 'task-card', role: 'region', 'aria-label': '当前会话任务悬浮监控', 'data-floating-card': true, style: { position: 'fixed', zIndex: 9997, left: cardX, top: cardY, width: cardWidth, maxWidth: '100vw', height: cardHeight, maxHeight: '100vh', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: compact ? 'auto' : 'hidden', background: t.bgWindow, color: t.textPrimary, border: `1px solid ${t.borderCard}`, borderRadius: '18px', boxShadow: t.isDark ? '0 12px 36px rgba(0,0,0,0.30)' : '0 12px 36px rgba(25,35,55,0.12), 0 2px 6px rgba(25,35,55,0.04)', fontSize: '12px', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif', lineHeight: 1.6 } },
        React.createElement('header', { style: { padding: '16px 18px 12px', flexShrink: 0, borderBottom: `1px solid ${t.borderRow}` } },
          React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            React.createElement('strong', { style: { flex: 1, fontSize: 15, letterSpacing: '0.2px' } }, '协作进度'),
            button(t.isDark ? '浅色' : '深色', toggleTheme),
            button('隐藏', () => setPrefs(prev => ({ ...prev, visible: false })))
          ),
          React.createElement('div', { role: 'status', style: { marginTop: 5, color: current?.error ? (t.isDark ? '#e7bc82' : '#94622a') : t.textTertiary, fontSize: 10, overflowWrap: 'anywhere' } }, syncText)),
        React.createElement('div', { 'data-monitor-summary': true, style: { padding: '12px 18px', flexShrink: 0 } },
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 } }, React.createElement('strong', { style: { fontSize: 13 } }, data ? `已验收 ${counts.done}/${tasks.length}` : '任务数量：尚无数据'), React.createElement('span', { style: { fontSize: 10, color: t.textTertiary } }, '任务验收进度')),
          tasks.length > 0 && React.createElement('div', { role: 'progressbar', 'aria-label': '整体任务验收进度', 'aria-valuemin': 0, 'aria-valuemax': tasks.length || undefined, 'aria-valuenow': tasks.length ? counts.done : undefined, 'aria-valuetext': tasks.length ? `已验收 ${counts.done}/${tasks.length}` : data ? '暂无任务，无进度分母' : '尚无任务快照，无进度分母', style: { height: 5, borderRadius: 5, overflow: 'hidden', background: mutedSurface } }, React.createElement('div', { style: { width: `${tasks.length ? counts.done / tasks.length * 100 : 0}%`, height: '100%', background: accent, borderRadius: 5 } })),
         ),
         React.createElement('div', { 'data-task-list': true, style: { flex: compact ? '0 0 auto' : 1, minHeight: compact ? undefined : 0, overflowY: compact ? 'visible' : 'auto', padding: '0 12px 12px', background: t.bgBody } },
          (!data || !tasks.length) && React.createElement('div', { 'data-empty-state': current?.error ? 'error' : !sessionId ? 'session' : !data ? 'loading' : 'empty', style: { textAlign: 'center', padding: '28px 16px', color: t.textTertiary } }, React.createElement('div', { 'aria-hidden': true, style: { width: 34, height: 34, margin: '0 auto 10px', borderRadius: 11, border: `1px solid ${t.borderCard}`, background: mutedSurface, display: 'grid', placeItems: 'center', fontSize: 16 } }, current?.error ? '!' : '≡'), React.createElement('strong', { style: { display: 'block', fontSize: 13, color: t.textPrimary, marginBottom: 4 } }, current?.error && !data ? '任务快照加载失败' : !sessionId ? '请选择当前会话' : !data ? '正在同步任务快照' : '当前会话暂无任务'), React.createElement('div', { style: { fontSize: 11 } }, current?.error ? '自动同步将重试；尚未获取的数据不会推断为已完成。' : !data ? '真实任务记录将在同步成功后显示。' : '主控规划任务后，协作进度会显示在这里。')),
          data && tasks.length > 0 && (() => {
            const runningTasks = tasks.filter(task => task.status === 'running');
            const reviewTasks = tasks.filter(task => task.status === 'review');
            const pendingTasks = tasks.filter(task => task.status === 'pending' || task.status === 'needs_attention');
            const historyTasks = tasks.filter(task => ['done', 'cancelled', 'failed'].includes(task.status));

            const renderTaskItem = task => {
              const member = data.config?.members?.find(item => item.id === task.memberId);
              const blocked = data.availability?.blockedTasks?.find(item => item.taskId === task.id);
              const reasons = [];
              const waitingDependencies = blocked?.waitingDependencies?.length ? blocked.waitingDependencies : (task.dependencies || []).filter(id => tasks.find(item => item.id === id)?.status !== 'done');
              const rework = (Number.isFinite(task.retries) && task.retries > 0) || (task.reviewHistory || []).some(record => record.passed === false);
              const stage = task.status === 'pending' ? waitingDependencies.length ? '等待依赖' : rework ? '返工待执行' : task.memberId ? '待派发' : '待分配'
                : task.status === 'running' ? rework ? '返工执行中' : '执行中'
                : task.status === 'review' ? '待主控审查'
                : task.status === 'done' ? '已验收'
                : task.status === 'needs_attention' ? task.waitingReason === 'RETRY_LIMIT_REACHED' ? '等待额外返工授权' : '已中断或失败，等待重试'
                : task.status === 'failed' ? '执行失败' : task.status === 'cancelled' ? '已取消' : '暂无环节数据';
              if (waitingDependencies.length) reasons.push(`等待依赖：${waitingDependencies.join('、')}`);
              if (blocked?.memberBusy) reasons.push('成员忙碌');
              if (blocked?.writeScopeConflicts?.length) reasons.push(`写入范围冲突：${blocked.writeScopeConflicts.join('、')}`);
              if (blocked?.reason) reasons.push(recordText(blocked.reason));
              if (task.waitingReason) reasons.push(({ RETRY_LIMIT_REACHED: '返工上限已达，等待额外返工授权', INTERRUPTED_RESTART: '重启中断，等待核查续做' })[task.waitingReason] || task.waitingReason);
              if (task.status === 'pending') {
                if (data.board?.status === 'paused') reasons.push('批次已暂停派发');
                if (data.availability?.freeSlots === 0) reasons.push('已达并发上限');
                if (data.board && data.board.approved === false) reasons.push('未批准原因：计划待主控或用户批准');
                if (!reasons.length) reasons.push(blocked ? '等待派发' : '等待原因暂不可用');
              }
              if (task.status === 'needs_attention') {
                if (!task.waitingReason) reasons.push('已中断或失败，等待重试');
                if (data.board?.status === 'paused') reasons.push('批次已暂停');
                if (data.board && data.board.approved === false) reasons.push('未批准原因：计划待主控或用户批准');
              }
              const reviewHistory = Array.isArray(task.reviewHistory) ? task.reviewHistory : [];
              const continuation = (task.executionHistory || []).filter(record => record.status === 'recovery-confirmed');
              const result = task.result;
              const structuredResult = result && typeof result === 'object' && !Array.isArray(result);
              const extraResult = structuredResult ? Object.fromEntries(Object.entries(result).filter(([key]) => !['output', 'error', 'files'].includes(key))) : null;
              const warning = ['needs_attention', 'failed'].includes(task.status);
              const stageColor = warning ? (t.isDark ? '#e7bc82' : '#94622a') : ['running', 'review', 'done'].includes(task.status) ? accent : t.textSecondary;
              const stageBg = warning ? (t.isDark ? '#352e25' : '#faf3e9') : ['running', 'review', 'done'].includes(task.status) ? (t.isDark ? '#293247' : '#edf1fc') : mutedSurface;
              const memberName = member?.name || task.memberId || '未分配';
              const modelName = task.model || member?.model || '';
              const roleName = member?.role || '';
              const isNeedsAttention = task.status === 'needs_attention';

              return React.createElement('article', { key: task.id, style: { padding: '13px', marginTop: 10, background: t.bgCard, border: `1px solid ${t.borderCard}`, borderRadius: '12px', overflowWrap: 'anywhere' } },
                React.createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.5, marginBottom: 8 } }, task.title || task.id),
                React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
                  React.createElement('span', { 'data-task-stage': true, title: `${TASK_STATUS_CONFIG[task.status]?.text || task.status}${task.status === 'running' ? '；子模型未上报细分步骤；不推断代码或测试进度' : ''}`, style: { padding: '3px 8px', borderRadius: 7, fontSize: 10, fontWeight: 600, color: stageColor, background: stageBg } }, `当前环节：${stage}`),
                  isNeedsAttention && React.createElement('span', { 'data-recovery-marker': true, title: '需核查现场并确认续做说明', style: { padding: '3px 8px', borderRadius: 7, fontSize: 10, fontWeight: 600, color: t.isDark ? '#ffb340' : '#b25e00', background: t.isDark ? 'rgba(255,149,0,0.2)' : 'rgba(255,149,0,0.15)' } }, '【待恢复 / 重试】'),
                  React.createElement('span', { 'data-member-info': true, title: roleName || '', style: { padding: '2px 6px', borderRadius: 5, color: t.textTertiary, background: mutedSurface, fontSize: 10, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${memberName}${modelName ? ` · 模型：${modelName}` : ''}${roleName ? ` · ${roleName}` : ''}`)),
                React.createElement('div', { 'data-task-metrics': true, style: { display: 'flex', flexWrap: 'wrap', gap: '4px 14px', margin: '10px 0', color: t.textSecondary, fontSize: 10 } },
                  React.createElement('span', null, `耗时：${taskElapsed(task, current?.error || hidden ? current?.updatedAt : Date.now())}`),
                  React.createElement('span', { title: '返工次数为当前轮计数；超限获批后可能重计数，不等于累计历史' }, `返工次数：${Number.isFinite(task.retries) ? task.retries : '暂无数据'}`)),
                React.createElement(TaskExecutionControls, { sessionId, task, data }),
                reasons.length > 0 && React.createElement('div', { 'data-waiting-reasons': true, style: { padding: '7px 9px', borderRadius: 7, background: mutedSurface, color: t.textSecondary, fontSize: 11, marginBottom: 10 } }, reasons.join('；')),
                React.createElement('details', { style: { fontSize: 11 } }, React.createElement('summary', { style: { cursor: 'pointer', color: t.textTertiary, padding: '2px 0' } }, '结果 / 审查 / 续做记录'),
                  (task.taskType || (task.deliverables && task.deliverables.length) || task.evidence) && detailSection('任务要求与结果', task.taskType ? detailLine('任务类型', task.taskType) : null, task.deliverables && task.deliverables.length ? detailLine('成果清单', task.deliverables.map(d => `${d.path} (${d.type || 'file'})`).join('\n')) : null, task.evidence && task.evidence.summary ? detailLine('实测结果摘要', task.evidence.summary) : null),
                  detailSection('结果', structuredResult ? detailLine('输出', result.output) : detailLine('输出', result), structuredResult && detailLine('错误', result.error), structuredResult && detailLine('文件', Array.isArray(result.files) ? result.files.length ? result.files.map(detailText).join('\n') : null : result.files), extraResult && Object.keys(extraResult).length > 0 && detailLine('其他结果信息', extraResult)),
                  detailSection('审查', detailLine('当前反馈', task.feedback), reviewHistory.length ? React.createElement('ol', { style: { margin: '6px 0 0', paddingLeft: 18 } }, reviewHistory.map((record, index) => React.createElement('li', { key: index, style: { padding: '4px 0' } }, React.createElement('div', { style: { color: t.textSecondary } }, `审查结果：${record.passed === true ? '通过' : record.passed === false ? '未通过' : '暂无记录'} · attempt：${record.attempt ?? '暂无记录'}`), detailLine('反馈', record.feedback)))) : detailLine('审查历史', null)),
                  detailSection('续做', detailLine('检查点说明', task.checkpoint?.note), continuation.length ? React.createElement('ol', { style: { margin: '6px 0 0', paddingLeft: 18 } }, continuation.map((record, index) => React.createElement('li', { key: index, style: { padding: '4px 0' } }, detailLine('已确认续做说明', record.note)))) : detailLine('已确认续做说明', null))));
            };

            const renderTaskBox = (boxKey, title, boxTasks, emptyText) => React.createElement('section', {
              key: `box-${boxKey}`,
              'data-task-box': boxKey,
              style: {
                marginTop: 10,
                padding: '10px 12px',
                background: t.isDark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.02)',
                border: `1px solid ${t.borderCard}`,
                borderRadius: '12px',
              }
            },
              React.createElement('div', {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: boxTasks.length ? 4 : 0,
                }
              },
                React.createElement('strong', {
                  style: { fontSize: 12, color: t.textPrimary, display: 'flex', alignItems: 'center', gap: 6 }
                }, title),
                React.createElement('span', {
                  'data-box-count': boxKey,
                  style: {
                    fontSize: 10,
                    fontWeight: 600,
                    padding: '1px 7px',
                    borderRadius: 10,
                    background: boxTasks.length ? (boxKey === 'running' ? (t.isDark ? 'rgba(100,210,255,0.2)' : 'rgba(0,113,227,0.12)') : boxKey === 'review' ? (t.isDark ? 'rgba(255,214,10,0.2)' : 'rgba(255,149,0,0.15)') : mutedSurface) : mutedSurface,
                    color: boxTasks.length ? (boxKey === 'running' ? (t.isDark ? '#64d2ff' : '#0071e3') : boxKey === 'review' ? (t.isDark ? '#ffd60a' : '#b25e00') : t.textSecondary) : t.textTertiary,
                  }
                }, `${boxTasks.length}`)
              ),
              boxTasks.length === 0
                ? React.createElement('div', {
                    'data-box-empty': boxKey,
                    style: { padding: '10px 4px', textAlign: 'center', fontSize: 11, color: t.textTertiary }
                  }, emptyText)
                : boxTasks.map(renderTaskItem)
            );

            const renderHistoryBox = () => {
              if (!historyTasks.length) return null;
              return React.createElement('section', {
                key: 'box-history',
                'data-task-box': 'history',
                style: {
                  marginTop: 12,
                  padding: '10px 12px',
                  background: t.isDark ? 'rgba(255, 255, 255, 0.02)' : 'rgba(0, 0, 0, 0.015)',
                  border: `1px dashed ${t.borderCard}`,
                  borderRadius: '12px',
                }
              },
                React.createElement('div', {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 6,
                  }
                },
                  React.createElement('strong', {
                    style: { fontSize: 12, color: t.textTertiary, display: 'flex', alignItems: 'center', gap: 6 }
                  }, '📁 历史记录（已完成/取消/失败）'),
                  React.createElement('span', {
                    'data-box-count': 'history',
                    style: { fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 10, background: mutedSurface, color: t.textTertiary }
                  }, `${historyTasks.length}`)
                ),
                historyTasks.map(renderTaskItem)
              );
            };

            return React.createElement(React.Fragment, null,
              isDraining && React.createElement('div', {
                'data-drain-warning': true,
                role: 'alert',
                style: {
                  marginTop: 10,
                  padding: '9px 12px',
                  borderRadius: '8px',
                  background: t.isDark ? 'rgba(255, 69, 58, 0.2)' : '#fff1f0',
                  border: `1px solid ${t.isDark ? '#ff453a' : '#ff4d4f'}`,
                  color: t.isDark ? '#ff7875' : '#cf1322',
                  fontSize: '11px',
                  fontWeight: '600',
                  lineHeight: 1.5,
                }
              }, `⚠️ 停工收尾中 (draining) / 未安全关机：当前有 ${counts.running} 个任务仍在运行中，尚未安全关机，请勿直接关闭进程或关机！`),
              renderTaskBox('running', '⚡ 运行中', runningTasks, '暂无运行中任务'),
              renderTaskBox('review', '🔍 审计中', reviewTasks, '暂无待审查任务'),
              renderTaskBox('pending', '⏳ 待执行', pendingTasks, '暂无待执行任务'),
              renderHistoryBox()
            );
          })()),
        React.createElement('footer', { style: { flexShrink: 0, padding: '10px 14px 12px', borderTop: `1px solid ${t.borderRow}`, background: t.bgWindow } },
          React.createElement('div', { style: { color: t.textTertiary, fontSize: 10, marginBottom: 8 } }, `上次更新时间：${current?.updatedAt ? new Date(current.updatedAt).toLocaleTimeString() : '尚未成功同步'}`),
          React.createElement('button', { type: 'button', onClick: onOpen, style: { width: '100%', padding: '9px 12px', borderRadius: 9, border: 'none', background: t.isDark ? '#ced9f5' : '#263c67', color: t.isDark ? '#1e273a' : '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' } }, '打开完整面板')),
        // 四条边拉伸手柄
        React.createElement('div', { role: 'separator', 'aria-label': '顶部拉伸边', onPointerDown: e => startResize('n', e), style: { position: 'absolute', top: 0, left: 10, right: 10, height: 6, cursor: 'ns-resize', zIndex: 10, touchAction: 'none' } }),
        React.createElement('div', { role: 'separator', 'aria-label': '底部拉伸边', onPointerDown: e => startResize('s', e), style: { position: 'absolute', bottom: 0, left: 10, right: 10, height: 6, cursor: 'ns-resize', zIndex: 10, touchAction: 'none' } }),
        React.createElement('div', { role: 'separator', 'aria-label': '左侧拉伸边', onPointerDown: e => startResize('w', e), style: { position: 'absolute', top: 10, bottom: 10, left: 0, width: 6, cursor: 'ew-resize', zIndex: 10, touchAction: 'none' } }),
        React.createElement('div', { role: 'separator', 'aria-label': '右侧拉伸边', onPointerDown: e => startResize('e', e), style: { position: 'absolute', top: 10, bottom: 10, right: 0, width: 6, cursor: 'ew-resize', zIndex: 10, touchAction: 'none' } }),
        // 四个角拉伸手柄
        React.createElement('div', { role: 'separator', 'aria-label': '左上角拉伸', onPointerDown: e => startResize('nw', e), style: { position: 'absolute', top: 0, left: 0, width: 14, height: 14, cursor: 'nwse-resize', zIndex: 11, touchAction: 'none' } }),
        React.createElement('div', { role: 'separator', 'aria-label': '右上角拉伸', onPointerDown: e => startResize('ne', e), style: { position: 'absolute', top: 0, right: 0, width: 14, height: 14, cursor: 'nesw-resize', zIndex: 11, touchAction: 'none' } }),
        React.createElement('div', { role: 'separator', 'aria-label': '左下角拉伸', onPointerDown: e => startResize('sw', e), style: { position: 'absolute', bottom: 0, left: 0, width: 14, height: 14, cursor: 'nesw-resize', zIndex: 11, touchAction: 'none' } }),
        React.createElement('div', { role: 'separator', 'aria-label': '右下角拉伸', title: '拖拽四周边缘或角落调整窗口大小', onPointerDown: e => startResize('se', e), style: { position: 'absolute', right: 3, bottom: 3, width: 18, height: 18, cursor: 'nwse-resize', zIndex: 11, touchAction: 'none', userSelect: 'none', opacity: 0.6 } }, React.createElement('svg', { width: 18, height: 18, viewBox: '0 0 18 18', style: { display: 'block' } }, React.createElement('path', { d: 'M14 3 L3 14', stroke: t.textTertiary, strokeWidth: 1.5, fill: 'none', strokeLinecap: 'round' }), React.createElement('path', { d: 'M14 7 L7 14', stroke: t.textTertiary, strokeWidth: 1.5, fill: 'none', strokeLinecap: 'round' }))));
      return React.createElement(React.Fragment, null, ball, card);
    }

    function LeadWorkerDialog({ sessionId, isOpen, onClose, themeMode, toggleTheme, monitor, floatingVisible = true, toggleFloating }) {
      const [tab, setTab] = React.useState('board'); // 'board' | 'lead' | 'members'
      const [viewData, setViewData] = React.useState(null);
      const [configDraft, setConfigDraft] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [errorMsg, setErrorMsg] = React.useState('');
      const [saveNotice, setSaveNotice] = React.useState('');
      const [continuationNotes, setContinuationNotes] = React.useState({});
      const autopilotDraftEdited = React.useRef(false);
      const draftBaseConfig = React.useRef(null);

      const t = THEMES[themeMode] || THEMES.light;

      const fetchView = React.useCallback(async () => {
        if (monitor) return viewStreams.get(sessionId)?.refresh();
        try {
          const res = await fetch(`/api/lead-worker/view?sessionId=${encodeURIComponent(sessionId)}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (data.ok) {
            setViewData(data);
            if (!draftBaseConfig.current) draftBaseConfig.current = JSON.parse(JSON.stringify(data.config));
            setConfigDraft(prev => prev ?? { ...JSON.parse(JSON.stringify(data.config)), bossDirect: isBossDirectActive(data.config) });
          }
        } catch (err) {
          setErrorMsg(err.message);
        }
      }, [sessionId, monitor]);

      React.useEffect(() => {
        setViewData(null);
        setConfigDraft(null);
        setErrorMsg('');
        setSaveNotice('');
        setContinuationNotes({});
        autopilotDraftEdited.current = false;
        draftBaseConfig.current = null;
      }, [sessionId, isOpen]);

      React.useEffect(() => {
        if (isOpen) viewStreams.get(sessionId)?.refresh?.();
      }, [sessionId, isOpen]);

      React.useEffect(() => {
        if (!isOpen || monitor) return;
        fetchView();
        const timer = setInterval(fetchView, 3000);
        return () => clearInterval(timer);
      }, [isOpen, fetchView, monitor]);

      React.useEffect(() => {
        if (!isOpen || !monitor) return;
        setViewData(monitor.sessionId === sessionId ? monitor.data : null);
        setErrorMsg(monitor.error || '');
        if (monitor.sessionId === sessionId && monitor.data?.config) {
          if (!draftBaseConfig.current) draftBaseConfig.current = JSON.parse(JSON.stringify(monitor.data.config));
          setConfigDraft(prev => prev ? { ...prev, bossDirect: isBossDirectActive(monitor.data.config), autopilot: autopilotDraftEdited.current ? prev.autopilot : monitor.data.config.autopilot === true } : { ...JSON.parse(JSON.stringify(monitor.data.config)), bossDirect: isBossDirectActive(monitor.data.config) });
        }
      }, [sessionId, isOpen, monitor]);

      const postAction = async (action, params = {}) => {
        setLoading(true);
        setErrorMsg('');
        setSaveNotice('');
        try {
          if (action === 'configure' && params.config) {
            const latestResponse = await fetch(`/api/lead-worker/view?sessionId=${encodeURIComponent(sessionId)}`);
            const latest = await latestResponse.json();
            if (!latest.ok) throw new Error(latest.error || '无法核对最新开关状态');
            const merged = { ...latest.config };
            const baseline = draftBaseConfig.current || latest.config;
            for (const [key, value] of Object.entries(params.config)) {
              if (key === 'bossDirect' || key === 'autopilot') continue;
              if (JSON.stringify(value) !== JSON.stringify(baseline[key])) {
                if (JSON.stringify(latest.config[key]) !== JSON.stringify(baseline[key])) throw new Error(`配置项 ${key} 已被其他入口更新，请重新打开设置后编辑`);
                merged[key] = value;
              }
            }
            merged.autopilot = autopilotDraftEdited.current ? params.config.autopilot : latest.config.autopilot;
            params = { ...params, config: merged, expectedConfigRevision: latest.configRevision };
          }
          let res = await fetch('/api/lead-worker/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, action, ...params }),
          });
          let result = await res.json();
          // 如果宿主尚未重启识别 bossDirect 字段，降级移除顶层 bossDirect 字段重试（规则已通过 leadPrompt 同步注入）
          if (!result.ok && result.error && result.error.includes('unknown field bossDirect') && params.config) {
            const fallbackCfg = { ...params.config };
            delete fallbackCfg.bossDirect;
            res = await fetch('/api/lead-worker/action', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId, action, ...params, config: fallbackCfg }),
            });
            result = await res.json();
          }
          if (!result.ok) throw new Error(result.error || '操作失败');
          // pause/resume API 返回最新 board 快照；先乐观替换本地快照，避免共享 monitor 流刷新延迟造成“点击无效”的假象。
          if ((action === 'pause' || action === 'resume') && result.result?.status) {
            const nextBoard = result.result;
            setViewData(prev => prev ? { ...prev, board: nextBoard } : prev);
            const stream = viewStreams.get(sessionId);
            if (stream?.snapshot.data) {
              stream.snapshot = { ...stream.snapshot, data: { ...stream.snapshot.data, board: nextBoard } };
              stream.emit();
            }
            setSaveNotice(action === 'pause' ? '已暂停后续新派发，运行中的任务继续收尾' : '已恢复派发，BOSS直派将继续调度待执行任务');
            setTimeout(() => setSaveNotice(''), 3000);
          }
          if (action === 'configure') {
            autopilotDraftEdited.current = false;
            const returnedConfig = result.result?.config || params.config;
            draftBaseConfig.current = JSON.parse(JSON.stringify(returnedConfig));
            setConfigDraft(JSON.parse(JSON.stringify({ ...returnedConfig, bossDirect: params.config?.bossDirect ?? returnedConfig.bossDirect })));
            setSaveNotice('设置已保存，BOSS直派与任务规则已即时生效');
            setTimeout(() => setSaveNotice(''), 3000);
          }
          await fetchView();
        } catch (err) {
          setErrorMsg(err.message);
        } finally {
          setLoading(false);
        }
      };

      if (!isOpen) return null;

      const activeView = monitor ? (monitor.sessionId === sessionId ? monitor.data : null) : viewData;
      const board = activeView?.board;
      const models = activeView?.models || [];
      const tasks = board?.tasks || [];
      const statusCfg = board ? (STATUS_CONFIG[board.status] || STATUS_CONFIG.draft) : STATUS_CONFIG.draft;
      const statusColor = t.isDark ? statusCfg.colorDark : statusCfg.colorLight;
      const statusBg = t.isDark ? statusCfg.bgDark : statusCfg.bgLight;

      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            backgroundColor: t.bgOverlay,
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
          },
          onClick: onClose
        },
        React.createElement(
          'div',
          {
            style: {
              width: '860px',
              maxWidth: '94vw',
              height: '690px',
              maxHeight: '90vh',
              backgroundColor: t.bgWindow,
              borderRadius: '16px',
              border: `1px solid ${t.borderWindow}`,
              boxShadow: t.shadowWindow,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              color: t.textPrimary,
              fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif',
            },
            onClick: (e) => e.stopPropagation()
          },

          // macOS TitleBar
          React.createElement(
            'div',
            {
              style: {
                height: '52px',
                minHeight: '52px',
                padding: '0 18px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottom: `1px solid ${t.borderTitleBar}`,
                backgroundColor: t.bgTitleBar,
              }
            },
            // Left: Traffic lights
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              React.createElement('button', {
                style: { width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#ff5f56', border: 'none', cursor: 'pointer' },
                onClick: onClose,
                title: '关闭窗口'
              }),
              React.createElement('button', {
                style: { width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#ffbd2e', border: 'none', cursor: 'pointer' },
                onClick: onClose,
                title: '最小化'
              }),
              React.createElement('button', {
                style: { width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#27c93f', border: 'none' },
                title: '全屏'
              })
            ),
            // Center: Title + Status + BOSS Direct Toggle Button
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              React.createElement('span', { style: { fontSize: '13px', fontWeight: '600', color: t.textTitle } }, '👔 BOSS直派控制台'),
              React.createElement(
                'span',
                {
                  style: {
                    fontSize: '11px',
                    fontWeight: '600',
                    padding: '3px 10px',
                    borderRadius: '12px',
                    color: statusColor,
                    backgroundColor: statusBg,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                  }
                },
                `● ${statusCfg.text}`
              )
            ),
            // Right: Theme Toggle Button (自选黑白)
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: t.textSecondary, cursor: 'pointer' }, title: '仅保存本界面的共享偏好，不修改团队配置；开启即显示，无任务时显示空闲' },
                React.createElement('input', { type: 'checkbox', 'aria-label': '显示悬浮任务球', checked: floatingVisible, disabled: typeof toggleFloating !== 'function', onChange: event => toggleFloating?.(event.target.checked) }), '显示悬浮任务球'),
              React.createElement(
                'button',
                {
                  style: {
                    padding: '4px 10px',
                    fontSize: '12px',
                    fontWeight: '500',
                    borderRadius: '6px',
                    border: `1px solid ${t.btnSecondaryBorder}`,
                    backgroundColor: t.btnSecondaryBg,
                    color: t.btnSecondaryText,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                  },
                  onClick: toggleTheme,
                  title: '点击在纯白明亮模式与深色夜间模式之间切换'
                },
                t.isDark ? '☀️ 浅色' : '🌙 深色'
              )
            )
          ),

          // Top Segmented Bar & Floating Action (永远固定在上方)
          React.createElement(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 20px',
                borderBottom: `1px solid ${t.borderTabContainer}`,
                backgroundColor: t.bgTabContainer,
                gap: '12px',
              }
            },
            // Segmented Tabs
            React.createElement(
              'div',
              {
                style: {
                  display: 'inline-flex',
                  backgroundColor: t.bgSegmentCtrl,
                  borderRadius: '8px',
                  padding: '3px',
                  gap: '2px',
                }
              },
              React.createElement(
                'button',
                {
                  style: {
                    padding: '6px 16px',
                    borderRadius: '6px',
                    border: 'none',
                    fontSize: '12px',
                    fontWeight: tab === 'board' ? '600' : '400',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    backgroundColor: tab === 'board' ? t.bgSegmentActive : 'transparent',
                    color: tab === 'board' ? t.textSegmentActive : t.textSegmentInactive,
                    boxShadow: tab === 'board' ? t.shadowSegmentActive : 'none',
                  },
                  onClick: () => setTab('board')
                },
                `任务执行看板 (${tasks.length})`
              ),
              React.createElement(
                'button',
                {
                  style: {
                    padding: '6px 16px',
                    borderRadius: '6px',
                    border: 'none',
                    fontSize: '12px',
                    fontWeight: tab === 'lead' ? '600' : '400',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    backgroundColor: tab === 'lead' ? t.bgSegmentActive : 'transparent',
                    color: tab === 'lead' ? t.textSegmentActive : t.textSegmentInactive,
                    boxShadow: tab === 'lead' ? t.shadowSegmentActive : 'none',
                  },
                  onClick: () => setTab('lead')
                },
                '主控司令官规则 (Lead)'
              ),
              React.createElement(
                'button',
                {
                  style: {
                    padding: '6px 16px',
                    borderRadius: '6px',
                    border: 'none',
                    fontSize: '12px',
                    fontWeight: tab === 'members' ? '600' : '400',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    backgroundColor: tab === 'members' ? t.bgSegmentActive : 'transparent',
                    color: tab === 'members' ? t.textSegmentActive : t.textSegmentInactive,
                    boxShadow: tab === 'members' ? t.shadowSegmentActive : 'none',
                  },
                  onClick: () => setTab('members')
                },
                `子模型团队与调度 (${configDraft?.members?.length || 0})`
              )
            ),

            // Top Floating Save Button
            (tab === 'lead' || tab === 'members') && React.createElement(
              'button',
              {
                style: {
                  backgroundColor: '#0071e3',
                  backgroundImage: 'linear-gradient(180deg, #0077ed 0%, #006edb 100%)',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '7px',
                  padding: '6px 18px',
                  fontSize: '12px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  boxShadow: '0 2px 6px rgba(0, 113, 227, 0.35)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  whiteSpace: 'nowrap',
                },
                disabled: loading || !configDraft,
                onClick: () => postAction('configure', { config: configDraft }),
                title: '修改任何配置后点击即可即时生效'
              },
              loading ? '正在保存...' : '💾 保存配置'
            )
          ),

          // Alerts
          errorMsg && React.createElement(
            'div',
            { style: { backgroundColor: 'rgba(255, 59, 48, 0.15)', color: '#d70015', padding: '8px 20px', fontSize: '12px', borderBottom: '1px solid rgba(255, 59, 48, 0.25)', fontWeight: '500' } },
            `⚠️ ${errorMsg}`
          ),
          saveNotice && React.createElement(
            'div',
            { style: { backgroundColor: 'rgba(52, 199, 89, 0.15)', color: '#248a3d', padding: '8px 20px', fontSize: '12px', borderBottom: '1px solid rgba(52, 199, 89, 0.25)', fontWeight: '500' } },
            `✓ ${saveNotice}`
          ),

          board?.recovery && React.createElement(
            'div',
            { role: 'status', style: { backgroundColor: t.isDark ? 'rgba(255,159,10,0.16)' : '#fff8ea', color: t.textSecondary, padding: '10px 20px', fontSize: '12px', lineHeight: '1.6', borderBottom: `1px solid ${t.borderRow}` } },
            React.createElement('strong', null, '恢复提示：检测到执行中断记录。'),
            board.recovery.interruptedAt && React.createElement('div', null, `中断时间：${new Date(board.recovery.interruptedAt).toLocaleString()}`),
            board.recovery.reason && React.createElement('div', null, `原因：${board.recovery.reason}`),
            React.createElement('div', null, '尚未确认文件与测试状态，请自行核查后填写续做说明；此提示不表示检查已完成。未完成任务需主控继续派发。')
          ),

          // Scrollable Body
          React.createElement(
            'div',
            {
              style: {
                flex: 1,
                overflowY: 'auto',
                padding: '22px 24px',
                backgroundColor: t.bgBody,
              }
            },
            tab === 'board' && renderBoardTab(),
            tab === 'lead' && renderLeadTab(),
            tab === 'members' && renderMembersTab()
          )
        )
      );

      // TAB 1: 任务看板
      function renderBoardTab() {
        if (!board || tasks.length === 0) {
          return React.createElement(
            'div',
            { style: { textAlign: 'center', padding: '70px 20px', color: t.textTertiary } },
            React.createElement('div', { style: { fontSize: '46px', marginBottom: '16px' } }, '🗂️'),
            React.createElement('div', { style: { fontSize: '16px', fontWeight: '600', color: t.textPrimary, marginBottom: '6px' } }, '当前任务板暂无任务'),
            React.createElement('div', { style: { fontSize: '13px', maxWidth: '440px', margin: '0 auto', lineHeight: '1.6', color: t.textSecondary } },
              '在下方会话输入框向主控模型提出开发需求，主控将根据规则提炼工作纲要并分解为子任务书展示在此处。'
            )
          );
        }

        return React.createElement(
          'div',
          null,
          // Control Toolbar
          React.createElement(
            'div',
            { style: { display: 'flex', gap: '8px', marginBottom: '16px', alignItems: 'center' } },
            board.status === 'ready' && React.createElement(
              'button',
              {
                style: {
                  padding: '6px 14px',
                  fontSize: '12px',
                  fontWeight: '500',
                  borderRadius: '7px',
                  border: `1px solid ${t.btnSecondaryBorder}`,
                  backgroundColor: t.btnSecondaryBg,
                  color: t.btnSecondaryText,
                  cursor: 'pointer',
                },
                disabled: loading,
                title: '停止新派发，当前任务继续收尾，不终止当前任务',
                onClick: () => postAction('pause')
              },
              '⏸️ 暂停批次'
            ),
            board.status === 'paused' && React.createElement(
              'button',
              {
                style: {
                  padding: '6px 14px',
                  fontSize: '12px',
                  fontWeight: '500',
                  borderRadius: '7px',
                  border: `1px solid ${t.btnSecondaryBorder}`,
                  backgroundColor: t.btnSecondaryBg,
                  color: t.btnSecondaryText,
                  cursor: 'pointer',
                },
                disabled: loading,
                title: '恢复派发并立即继续 BOSS直派自动调度',
                onClick: () => postAction('resume')
              },
              '▶️ 继续批次'
            ),
            board.status !== 'cancelled' && React.createElement(
              'button',
              {
                style: {
                  padding: '6px 14px', fontSize: '12px', fontWeight: '500', borderRadius: '7px',
                  border: `1px solid ${t.btnSecondaryBorder}`, backgroundColor: t.btnSecondaryBg,
                  color: t.btnSecondaryText, cursor: 'pointer',
                },
                disabled: loading,
                onClick: async () => {
                  if (window.confirm('确认中断执行？当前执行将被请求停止，文件可能包含未完成改动。续做前请核查文件和测试；未完成任务需主控继续派发。')) {
                    await postAction('interrupt');
                  }
                }
              },
              '⏹️ 中断执行'
            ),
            board.status !== 'cancelled' && React.createElement(
              'button',
              {
                style: {
                  backgroundColor: t.isDark ? 'rgba(255, 69, 58, 0.18)' : '#feeceb',
                  color: '#d70015',
                  border: t.isDark ? '1px solid rgba(255, 69, 58, 0.35)' : '1px solid #fec7c5',
                  borderRadius: '7px',
                  padding: '6px 14px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  fontWeight: '500',
                },
                onClick: () => postAction('cancel')
              },
              '🛑 取消全部'
            ),
            React.createElement('span', { style: { marginLeft: 'auto', fontSize: '12px', color: t.textTertiary } },
              `并行: ${tasks.filter(t => t.status === 'running').length}/${viewData?.config?.maxParallel || 1} · 完成: ${tasks.filter(t => t.status === 'done').length}/${tasks.length}`
            )
          ),

          React.createElement('div', { style: { fontSize: '12px', color: t.textSecondary, lineHeight: '1.6', marginBottom: '16px' } },
            '暂停批次只停止新派发，不终止当前任务，当前任务继续收尾。继续批次只恢复调度，不保证自动运行；未完成任务需主控继续派发。'
          ),

          // Task Cards
          tasks.map((task) => {
            const taskCfg = TASK_STATUS_CONFIG[task.status] || TASK_STATUS_CONFIG.pending;
            const tColor = t.isDark ? taskCfg.colorDark : taskCfg.colorLight;
            const tBg = t.isDark ? taskCfg.bgDark : taskCfg.bgLight;
            const noteKey = JSON.stringify([task.id, task.executionEpoch ?? null]);
            const continuationNote = continuationNotes[noteKey] || '';

            return React.createElement(
              'div',
              {
                key: task.id,
                style: {
                  backgroundColor: t.bgCard,
                  borderRadius: '12px',
                  border: `1px solid ${t.borderCard}`,
                  boxShadow: t.shadowCard,
                  padding: '16px',
                  marginBottom: '14px',
                }
              },
              // Header
              React.createElement(
                'div',
                { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' } },
                React.createElement(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                  React.createElement('span', { style: { fontWeight: '600', fontSize: '14px', color: t.textPrimary } }, task.title),
                  React.createElement('span', { style: { fontSize: '11px', color: t.textTertiary } }, `#${task.id}`),
                  task.locked && React.createElement('span', {
                    style: {
                      fontSize: '11px',
                      fontWeight: '600',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      color: t.isDark ? '#ffd60a' : '#b25e00',
                      backgroundColor: t.isDark ? 'rgba(255, 214, 10, 0.2)' : 'rgba(255, 149, 0, 0.15)',
                    }
                  }, '🔒 已锁定')
                ),
                React.createElement(
                  'span',
                  {
                    style: {
                      fontSize: '11px',
                      fontWeight: '600',
                      padding: '3px 10px',
                      borderRadius: '12px',
                      color: tColor,
                      backgroundColor: tBg,
                    }
                  },
                  taskCfg.text
                )
              ),

              // Instructions
              React.createElement(
                'div',
                { style: { fontSize: '13px', color: t.textSecondary, margin: '8px 0', lineHeight: '1.5' } },
                task.instructions
              ),

              // Acceptance
              task.acceptance && React.createElement(
                'div',
                {
                  style: {
                    fontSize: '12px',
                    color: t.textSecondary,
                    padding: '8px 12px',
                    backgroundColor: t.isDark ? 'rgba(0, 0, 0, 0.35)' : '#f5f5f7',
                    borderRadius: '8px',
                    marginBottom: '10px',
                    border: `1px solid ${t.borderRow}`,
                  }
                },
                React.createElement('span', { style: { color: '#0071e3', fontWeight: '600' } }, '验收要求: '),
                task.acceptance
              ),

              Boolean(task.taskType && task.taskType !== 'general') && React.createElement(
                'div',
                { style: { fontSize: '11px', color: t.textTertiary, marginBottom: '8px' } },
                `任务类型: ${task.taskType}${task.deliverables?.length ? ` · 成果: ${task.deliverables.map(d => d.path).join('、')}` : ''}`
              ),
              task.evidence?.dispatch && React.createElement(
                'div',
                { style: { fontSize: '11px', color: t.isDark ? '#b8eac5' : '#1f6b35', padding: '7px 10px', backgroundColor: t.isDark ? 'rgba(52,199,89,0.12)' : 'rgba(52,199,89,0.08)', borderRadius: '8px', marginBottom: '8px', border: `1px solid ${t.isDark ? 'rgba(52,199,89,0.25)' : 'rgba(52,199,89,0.2)'}` } },
                React.createElement('strong', null, task.evidence.dispatchStatus === 'completed' ? '✓ Lead Worker 子模型已完成调用' : task.evidence.dispatchStatus === 'failed' ? '⚠ Lead Worker 子模型启动失败' : '↗ Lead Worker 子模型已派发'),
                React.createElement('div', { style: { marginTop: '3px' } }, `${task.evidence.dispatch.memberName} · ${task.evidence.dispatch.provider}/${task.evidence.dispatch.model}`),
                task.evidence.dispatchError && React.createElement('div', { style: { marginTop: '3px', color: t.textSecondary } }, task.evidence.dispatchError)
              ),
              task.evidence?.summary && React.createElement(
                'div',
                { style: { fontSize: '12px', color: t.textSecondary, padding: '8px 12px', backgroundColor: t.isDark ? 'rgba(0,0,0,0.35)' : '#f5f5f7', borderRadius: '8px', marginBottom: '10px', whiteSpace: 'pre-wrap' } },
                React.createElement('strong', null, '执行结果（成员自报）: '),
                React.createElement('div', { style: { marginTop: '4px' } }, task.evidence.summary)
              ),

              React.createElement('div', { style: { fontSize: '12px', color: t.textTertiary, marginBottom: '8px' } },
                task.status === 'running' ? '⏳ 子模型正在执行，尚未返回结果' : task.status === 'review' ? '✓ 子模型已返回结果，等待主控审查' : task.status === 'pending' ? '○ 尚未启动子模型，等待派发' : task.status === 'done' ? '✓ 已完成并通过审查' : task.status === 'failed' ? '⚠ 子模型执行失败' : '',
                task.executionEpoch != null ? ` · 执行版本：${task.executionEpoch}` : ''
              ),
              task.checkpoint && React.createElement(
                'div',
                { style: { fontSize: '12px', color: t.textSecondary, padding: '8px 12px', backgroundColor: t.isDark ? 'rgba(0,0,0,0.35)' : '#f5f5f7', borderRadius: '8px', marginBottom: '10px', whiteSpace: 'pre-wrap' } },
                React.createElement('strong', null, '最近检查点（执行记录，不代表文件/测试已核查）：'),
                task.checkpoint.note && React.createElement('div', null, task.checkpoint.note),
                task.checkpoint.updatedAt && React.createElement('div', { style: { color: t.textTertiary } }, `更新时间：${new Date(task.checkpoint.updatedAt).toLocaleString()}`)
              ),
              React.createElement(TaskExecutionControls, { sessionId, task, data: activeView }),

              // Member assignment footer
              React.createElement(
                'div',
                { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: `1px solid ${t.borderRow}`, paddingTop: '10px', fontSize: '12px' } },
                React.createElement(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                  React.createElement('span', { style: { color: t.textTertiary, fontWeight: '500' } }, '执行子模型:'),
                  React.createElement(
                    'select',
                    {
                      style: {
                        backgroundColor: t.bgSelect,
                        border: `1px solid ${t.borderSelect}`,
                        borderRadius: '7px',
                        color: t.textSelect,
                        padding: '6px 12px',
                        fontSize: '12px',
                        outline: 'none',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      },
                      value: task.memberId || '',
                      disabled: task.status !== 'pending' && task.status !== 'needs_attention',
                      onChange: (e) => postAction('assign', { taskId: task.id, memberId: e.target.value })
                    },
                    React.createElement('option', { value: '' }, '-- 请选择执行成员 --'),
                    configDraft?.members?.map((m) =>
                      React.createElement('option', { key: m.id, value: m.id }, `${m.name} (${m.provider}/${m.model})`)
                    )
                  )
                ),

                task.status === 'needs_attention' && task.waitingReason === 'RETRY_LIMIT_REACHED' && React.createElement(
                  'button',
                  {
                    style: {
                      padding: '5px 12px', fontSize: '12px', borderRadius: '7px',
                      border: `1px solid ${t.btnSecondaryBorder}`, backgroundColor: t.btnSecondaryBg,
                      color: t.btnSecondaryText, cursor: 'pointer',
                    },
                    onClick: async () => {
                      if (window.confirm(`任务“${task.title}”已达返工上限。是否明确允许开启新的返工轮次？全部审查记录会保留；取消则保持暂停。`)) {
                        await postAction('retry', { taskId: task.id, continueAfterLimit: true });
                      }
                    }
                  },
                  '✅ 允许继续返工'
                ),


              ),

              // Review feedback
              task.feedback && React.createElement(
                'div',
                {
                  style: {
                    marginTop: '10px',
                    padding: '8px 12px',
                    backgroundColor: t.isDark ? 'rgba(255, 159, 10, 0.16)' : '#fff8ea',
                    borderRadius: '8px',
                    borderLeft: '3px solid #ff9500',
                    fontSize: '12px',
                    color: t.isDark ? '#ffd60a' : '#b25e00',
                  }
                },
                React.createElement('strong', null, '最近审查/返工意见: '),
                task.feedback
              ),

              task.reviewHistory?.length > 0 && React.createElement(
                'details',
                { style: { marginTop: '10px', color: t.textSecondary, fontSize: '12px' } },
                React.createElement('summary', { style: { cursor: 'pointer', fontWeight: '600', color: t.textPrimary } }, `📋 审查与返工历史（${task.reviewHistory.length} 次）`),
                React.createElement('div', { style: { marginTop: '8px', display: 'grid', gap: '8px' } },
                  task.reviewHistory.map((record, index) => React.createElement(
                    'div',
                    {
                      key: `${task.id}-review-${index}`,
                      style: {
                        padding: '9px 12px',
                        borderRadius: '8px',
                        backgroundColor: record.passed ? (t.isDark ? 'rgba(48,209,88,0.12)' : '#f0faf2') : (t.isDark ? 'rgba(255,159,10,0.14)' : '#fff8ea'),
                        borderLeft: `3px solid ${record.passed ? '#34c759' : '#ff9500'}`,
                      }
                    },
                    React.createElement('div', { style: { fontWeight: '600', color: record.passed ? '#248a3d' : (t.isDark ? '#ffd60a' : '#b25e00') } }, `第 ${index + 1} 次审查 · ${record.passed ? '通过' : '未通过'}`),
                    record.reviewedAt && React.createElement('div', { style: { marginTop: '2px', color: t.textTertiary } }, new Date(record.reviewedAt).toLocaleString()),
                    record.feedback && React.createElement('div', { style: { marginTop: '4px', whiteSpace: 'pre-wrap' } }, record.feedback)
                  ))
                )
              )
            );
          })
        );
      }

      // TAB 2: 主控司令官专属规则 (Lead Prompt)
      function renderLeadTab() {
        if (!configDraft) return null;

        const updateDraft = (patch) => {
          setConfigDraft((prev) => ({ ...prev, ...patch }));
        };

        return React.createElement(
          'div',
          null,
          React.createElement('div', { style: { fontSize: '12px', fontWeight: '600', color: t.textTertiary, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '10px' } }, '主控工作规则（中文描述）'),
          React.createElement(
            'div',
            {
              style: {
                backgroundColor: t.bgCard,
                borderRadius: '12px',
                border: `1px solid ${t.borderCard}`,
                boxShadow: t.shadowCard,
                padding: '20px',
                marginBottom: '20px',
              }
            },
            React.createElement('div', { style: { fontSize: '15px', fontWeight: '600', color: t.textPrimary, marginBottom: '6px' } }, '主控规则（建议中文描述）'),
            React.createElement('div', { style: { fontSize: '12px', color: t.textSecondary, marginBottom: '14px', lineHeight: '1.5' } },
              '此规则直接注入主控模型的系统指令。建议用中文写明任务分析、拆分、并行边界、审批、审查和汇报要求；修改后点击右上角“💾 保存配置”即可生效。'
            ),
            React.createElement('textarea', {
              style: {
                backgroundColor: t.bgTextarea,
                border: `1px solid ${t.borderTextarea}`,
                borderRadius: '8px',
                color: t.textTextarea,
                padding: '12px 14px',
                fontSize: '13px',
                lineHeight: '1.6',
                outline: 'none',
                resize: 'vertical',
                width: '100%',
                height: '260px',
                boxSizing: 'border-box',
                fontFamily: 'inherit',
              },
              value: configDraft.leadPrompt || '',
              placeholder: '请用中文填写主控规则，例如：收到需求先检查项目并拆分任务；为每项明确依赖、负责人、验收标准和不重叠的写入范围；仅并行执行互不冲突的任务；严格等待官方审批；用中文审查结果并给出具体返工意见。',
              onChange: (e) => updateDraft({ leadPrompt: e.target.value })
            })
          )
        );
      }

      // TAB 3: 子成员与全局模式
      function renderMembersTab() {
        if (!configDraft) return null;

        const updateDraft = (patch) => {
          setConfigDraft((prev) => ({ ...prev, ...patch }));
        };

        const updateMember = (index, patch) => {
          setConfigDraft((prev) => {
            const nextMembers = [...prev.members];
            nextMembers[index] = { ...nextMembers[index], ...patch };
            return { ...prev, members: nextMembers };
          });
        };

        const addMember = () => {
          setConfigDraft((prev) => {
            const newId = `worker-${Date.now().toString(36)}`;
            const firstModel = models[0] || { provider: 'new', model: 'gpt-6-sol' };
            return {
              ...prev,
              members: [
                ...prev.members,
                {
                  id: newId,
                  name: `新执行成员 ${prev.members.length + 1}`,
                  provider: firstModel.provider,
                  model: firstModel.model,
                  role: '负责具体任务实现',
                  instructions: '请全程使用中文。严格按主控任务书、验收标准和 writeScopes 执行，只修改分配范围，不碰其他任务的文件。先检查相关文件，再做最小必要改动并运行相关测试；完成后用中文报告改动文件、实现内容、测试命令与真实结果、风险或阻塞。遇到范围冲突、信息不足或无法验证时立即说明，不要猜测或虚报。',
                  enabled: true,
                  readOnly: false,
                }
              ]
            };
          });
        };

        const removeMember = (index) => {
          setConfigDraft((prev) => {
            const next = [...prev.members];
            next.splice(index, 1);
            return { ...prev, members: next };
          });
        };

        const cloneMember = (index) => {
          setConfigDraft((prev) => {
            const source = prev.members[index];
            if (!source) return prev;
            const baseId = `${source.id}-copy`;
            let newId = baseId;
            let suffix = 2;
            while (prev.members.some(member => member.id === newId)) newId = `${baseId}-${suffix++}`;
            const clone = {
              ...source,
              id: newId,
              name: `${source.name}（副本）`,
            };
            const members = [...prev.members];
            members.splice(index + 1, 0, clone);
            return { ...prev, members };
          });
        };

        return React.createElement(
          'div',
          null,
          // Dispatch Settings Group
          React.createElement('div', { style: { fontSize: '12px', fontWeight: '600', color: t.textTertiary, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '10px' } }, '调度策略与门禁约束'),
          React.createElement(
            'div',
            {
              style: {
                backgroundColor: t.bgCard,
                borderRadius: '12px',
                border: `1px solid ${t.borderCard}`,
                boxShadow: t.shadowCard,
                marginBottom: '24px',
              }
            },

            // Row 1: Enable
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderBottom: `1px solid ${t.borderRow}`, fontSize: '13px' } },
              React.createElement('span', { style: { fontWeight: '500', color: t.textPrimary } }, '激活主从协作模式 (BOSS直派)'),
              React.createElement('input', {
                type: 'checkbox',
                style: { width: '16px', height: '16px', cursor: 'pointer' },
                checked: configDraft.enabled,
                onChange: (e) => updateDraft({ enabled: e.target.checked })
              })
            ),


            // Row 2: Mode
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderBottom: `1px solid ${t.borderRow}`, fontSize: '13px' } },
              React.createElement(
                'div',
                null,
                React.createElement('div', { style: { fontWeight: '500', color: t.textPrimary } }, '分派策略 (Dispatch Mode)'),
                React.createElement('div', { style: { fontSize: '11px', color: t.textTertiary, marginTop: '2px' } }, '混合模式下主控自动规划，但你在看板拥有最高改派与锁定权')
              ),
              React.createElement(
                'select',
                {
                  style: {
                    backgroundColor: t.bgSelect,
                    border: `1px solid ${t.borderSelect}`,
                    borderRadius: '7px',
                    color: t.textSelect,
                    padding: '6px 12px',
                    fontSize: '12px',
                    outline: 'none',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  },
                  value: configDraft.mode,
                  onChange: (e) => updateDraft({ mode: e.target.value })
                },
                React.createElement('option', { value: 'mixed' }, '混合模式 (主控规划 + 用户干预)'),
                React.createElement('option', { value: 'auto' }, '全自动模式 (主控自主分派)'),
                React.createElement('option', { value: 'manual' }, '手动模式 (完全由用户指定)')
              )
            ),

            React.createElement('label', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 18px', borderBottom: `1px solid ${t.borderRow}`, background: t.bgCard } },
              React.createElement('div', null,
                React.createElement('strong', { style: { color: t.textPrimary } }, '全自动托管 · 当前会话'),
                React.createElement('div', { style: { fontSize: 11, marginTop: 5, color: t.textTertiary } }, '规划后自动派发，主控审查并推进下一阶段；不跳过验收、安全限制和返工上限。保存后生效。')),
              React.createElement('input', { type: 'checkbox', role: 'switch', 'aria-label': '当前会话全自动托管', checked: configDraft.autopilot === true, onChange: e => { autopilotDraftEdited.current = true; updateDraft({ autopilot: e.target.checked }); }, style: { width: 20, height: 20, accentColor: '#2979ed', cursor: 'pointer' } })),
            // Row 3: Confirm Plan
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderBottom: `1px solid ${t.borderRow}`, fontSize: '13px' } },
              React.createElement(
                'div',
                null,
                React.createElement('div', { style: { fontWeight: '500', color: t.textPrimary } }, '纲要确认门禁 (Plan Confirmation Gate)'),
                React.createElement('div', { style: { fontSize: '11px', color: t.textTertiary, marginTop: '2px' } }, '主控拆解完任务后需经你批准，子模型才会启动执行')
              ),
              React.createElement('input', {
                type: 'checkbox',
                style: { width: '16px', height: '16px', cursor: 'pointer' },
                checked: configDraft.confirmPlan,
                disabled: configDraft.autopilot === true,
                title: configDraft.autopilot ? '托管开启时无需常规计划审批；关闭托管后此设置生效' : '',
                onChange: (e) => updateDraft({ confirmPlan: e.target.checked })
              })
            ),

            // Row 3.5: Ask Approval Prompt Toggle
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderBottom: `1px solid ${t.borderRow}`, fontSize: '13px' } },
              React.createElement(
                'div',
                null,
                React.createElement('div', { style: { fontWeight: '500', color: t.textPrimary } }, '在对话流中弹出官方审批卡片 (Ask User Question)'),
                React.createElement('div', { style: { fontSize: '11px', color: t.textTertiary, marginTop: '2px' } }, '开启后主控拆完任务直接在对话输入框上方弹卡片供你点击批准，无需点进弹窗')
              ),
              React.createElement('input', {
                type: 'checkbox',
                style: { width: '16px', height: '16px', cursor: 'pointer' },
                checked: configDraft.askApprovalPrompt !== false,
                disabled: configDraft.autopilot === true,
                title: configDraft.autopilot ? '托管开启时不弹出常规计划审批' : '',
                onChange: (e) => updateDraft({ askApprovalPrompt: e.target.checked })
              })
            ),

            // Row 4: Max Parallel
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderBottom: `1px solid ${t.borderRow}`, fontSize: '13px' } },
              React.createElement('span', { style: { fontWeight: '500', color: t.textPrimary } }, '最大并发子任务数'),
              React.createElement('input', {
                type: 'number',
                min: 1,
                max: 1000,
                style: {
                  backgroundColor: t.bgInput,
                  border: `1px solid ${t.borderInput}`,
                  borderRadius: '7px',
                  color: t.textInput,
                  padding: '6px 10px',
                  fontSize: '12px',
                  outline: 'none',
                  width: '64px',
                  textAlign: 'center',
                },
                value: configDraft.maxParallel,
                onChange: (e) => updateDraft({ maxParallel: Math.min(1000, Math.max(1, parseInt(e.target.value, 10) || 1)) })
              })
            ),

            // Row 5: Max Retries
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', fontSize: '13px' } },
              React.createElement('span', { style: { fontWeight: '500', color: t.textPrimary } }, '主控审查最大返工重试次数'),
              React.createElement('input', {
                type: 'number',
                min: 0,
                max: 1000,
                style: {
                  backgroundColor: t.bgInput,
                  border: `1px solid ${t.borderInput}`,
                  borderRadius: '7px',
                  color: t.textInput,
                  padding: '6px 10px',
                  fontSize: '12px',
                  outline: 'none',
                  width: '64px',
                  textAlign: 'center',
                },
                value: configDraft.maxRetries,
                onChange: (e) => updateDraft({ maxRetries: Math.min(1000, Math.max(0, parseInt(e.target.value, 10) || 0)) })
              })
            )
          ),

          // Worker list header
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' } },
            React.createElement('div', { style: { fontSize: '12px', fontWeight: '600', color: t.textTertiary, textTransform: 'uppercase', letterSpacing: '0.6px' } }, '子模型专家团队 (Workers)'),
            React.createElement(
              'button',
              {
                style: {
                  padding: '6px 14px',
                  fontSize: '12px',
                  fontWeight: '500',
                  borderRadius: '7px',
                  border: `1px solid ${t.btnSecondaryBorder}`,
                  backgroundColor: t.btnSecondaryBg,
                  color: t.btnSecondaryText,
                  cursor: 'pointer',
                },
                onClick: addMember
              },
              '＋ 添加专家成员'
            )
          ),

          // Worker Cards
          configDraft.members.map((member, idx) => {
            return React.createElement(
              'div',
              {
                key: member.id,
                style: {
                  backgroundColor: t.bgCard,
                  borderRadius: '12px',
                  border: `1px solid ${t.borderCard}`,
                  boxShadow: t.shadowCard,
                  padding: '16px',
                  marginBottom: '14px',
                }
              },
              // Row 1: Name + Model + Delete
              React.createElement(
                'div',
                { style: { display: 'flex', gap: '10px', marginBottom: '12px' } },
                React.createElement('input', {
                  style: {
                    backgroundColor: t.bgInput,
                    border: `1px solid ${t.borderInput}`,
                    borderRadius: '7px',
                    color: t.textInput,
                    padding: '8px 12px',
                    fontSize: '13px',
                    fontWeight: '600',
                    flex: 1,
                    outline: 'none',
                  },
                  value: member.name,
                  placeholder: '成员名称，如 Sol (实现工程师)',
                  onChange: (e) => updateMember(idx, { name: e.target.value })
                }),
                React.createElement(
                  'select',
                  {
                    style: {
                      backgroundColor: t.bgSelect,
                      border: `1px solid ${t.borderSelect}`,
                      borderRadius: '7px',
                      color: t.textSelect,
                      padding: '7px 12px',
                      fontSize: '12px',
                      outline: 'none',
                      cursor: 'pointer',
                      flex: 1.4,
                    },
                    value: `${member.provider}:${member.model}`,
                    onChange: (e) => {
                      const [provider, ...rest] = e.target.value.split(':');
                      updateMember(idx, { provider, model: rest.join(':') });
                    }
                  },
                  models.length === 0 && React.createElement('option', { value: `${member.provider}:${member.model}` }, `${member.provider}/${member.model}`),
                  models.map((m) =>
                    React.createElement(
                      'option',
                      { key: `${m.provider}:${m.model}`, value: `${m.provider}:${m.model}` },
                      m.name
                    )
                  )
                ),
                React.createElement(
                  'button',
                  {
                    style: {
                      backgroundColor: t.btnSecondaryBg,
                      color: t.btnSecondaryText,
                      border: `1px solid ${t.btnSecondaryBorder}`,
                      borderRadius: '7px',
                      padding: '5px 12px',
                      fontSize: '12px',
                      cursor: 'pointer',
                      fontWeight: '500',
                      whiteSpace: 'nowrap',
                    },
                    onClick: () => cloneMember(idx)
                  },
                  '复制'
                ),
                React.createElement(
                  'button',
                  {
                    style: {
                      backgroundColor: t.isDark ? 'rgba(255, 69, 58, 0.18)' : '#feeceb',
                      color: '#d70015',
                      border: t.isDark ? '1px solid rgba(255, 69, 58, 0.35)' : '1px solid #fec7c5',
                      borderRadius: '7px',
                      padding: '5px 12px',
                      fontSize: '12px',
                      cursor: 'pointer',
                      fontWeight: '500',
                    },
                    onClick: () => removeMember(idx)
                  },
                  '删除'
                )
              ),

              // Role
              React.createElement('input', {
                style: {
                  backgroundColor: t.bgInput,
                  border: `1px solid ${t.borderInput}`,
                  borderRadius: '7px',
                  color: t.textInput,
                  padding: '8px 12px',
                  fontSize: '13px',
                  width: '100%',
                  marginBottom: '10px',
                  boxSizing: 'border-box',
                  outline: 'none',
                },
                value: member.role,
                placeholder: '请用中文描述职责，例如：负责指定模块编码、实现、自测与中文汇报',
                onChange: (e) => updateMember(idx, { role: e.target.value })
              }),

              // Instructions
              React.createElement('textarea', {
                style: {
                  backgroundColor: t.bgTextarea,
                  border: `1px solid ${t.borderTextarea}`,
                  borderRadius: '8px',
                  color: t.textTextarea,
                  padding: '10px 12px',
                  fontSize: '12px',
                  lineHeight: '1.5',
                  width: '100%',
                  height: '64px',
                  marginBottom: '10px',
                  outline: 'none',
                  resize: 'vertical',
                  boxSizing: 'border-box',
                },
                value: member.instructions,
                placeholder: '请用中文填写该子模型的职责、工作边界、可写范围、自测要求及交付汇报格式。',
                onChange: (e) => updateMember(idx, { instructions: e.target.value })
              }),

              // Options
              React.createElement(
                'div',
                { style: { display: 'flex', gap: '20px', fontSize: '12px', color: t.textSecondary } },
                React.createElement(
                  'label',
                  { style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: member.readOnly,
                    onChange: (e) => updateMember(idx, { readOnly: e.target.checked })
                  }),
                  '只读权限 (禁止修改文件)'
                ),
                React.createElement(
                  'label',
                  { style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: member.enabled,
                    onChange: (e) => updateMember(idx, { enabled: e.target.checked })
                  }),
                  '启用此成员'
                )
              )
            );
          })
        );
      }
    }

    function LeadWorkerAction({ sessionId }) {
      const [isOpen, setIsOpen] = React.useState(false);
      const [monitor, setMonitor] = React.useState(null);
      const [themeMode, setThemeMode] = React.useState(getInitialTheme);
      const [prefs, setPrefs] = React.useState(floatingPreferences);
      const [entryKey] = React.useState(() => ({}));
      const [floatingOwner, setFloatingOwner] = React.useState(false);
      const updatePrefs = React.useCallback(update => {
        sharedFloatingPrefs = typeof update === 'function' ? update(sharedFloatingPrefs || floatingPreferences()) : update;
        try { localStorage.setItem(FLOAT_PREF_KEY, JSON.stringify(sharedFloatingPrefs)); } catch {}
        notifyFloatingEntries();
      }, []);
      React.useEffect(() => {
        sharedFloatingPrefs = sharedFloatingPrefs || floatingPreferences();
        floatingEntries.set(entryKey, { sessionId, setPrefs, setOwner: setFloatingOwner });
        notifyFloatingEntries();
        return () => { floatingEntries.delete(entryKey); notifyFloatingEntries(); };
      }, [sessionId, entryKey]);
      const currentMonitor = monitor?.sessionId === sessionId ? monitor : { sessionId, data: null, updatedAt: null, error: '', syncing: true };
      const summary = currentMonitor.data ? {
        tasksCount: currentMonitor.data.board?.tasks?.length || 0,
        runningCount: currentMonitor.data.board?.tasks?.filter(task => task.status === 'running').length || 0,
        bossDirect: currentMonitor.data.config?.bossDirect === true
      } : null;

      const toggleTheme = () => {
        setThemeMode((prev) => {
          const next = prev === 'dark' ? 'light' : 'dark';
          try { localStorage.setItem('dsh_lead_worker_theme', next); } catch {}
          return next;
        });
      };

      React.useEffect(() => subscribeView(sessionId, isOpen || (prefs?.visible && !prefs.collapsed) ? 3000 : 10000, setMonitor), [sessionId, isOpen, prefs?.visible, prefs?.collapsed]);

      const t = THEMES[themeMode] || THEMES.light;

      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'button',
          {
            type: 'button',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              height: '28px',
              padding: '0 12px',
              borderRadius: '7px',
              fontSize: '12px',
              fontWeight: '500',
              // 自动适配外界外层：高清晰度深色文本或清晰自适应色
              color: 'var(--dsw-alias-label-primary, #1d1d1f)',
              backgroundColor: 'var(--dsw-alias-bg-module, #f0f0f2)',
              border: '1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.15))',
              cursor: 'pointer',
              boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
            },
            onClick: () => setIsOpen(true),
            title: 'BOSS直派与多模型分配设置',
          },
          React.createElement('span', null, '👔 BOSS直派')
        ),
        React.createElement(LeadWorkerDialog, {
          sessionId,
          isOpen,
          onClose: () => setIsOpen(false),
          themeMode,
          toggleTheme,
          monitor: currentMonitor,
          floatingVisible: prefs?.visible !== false,
          toggleFloating: visible => updatePrefs(prev => constrainFloating({ ...prev, visible })),
        }),
        prefs?.visible && floatingOwner && floatingPortal(React.createElement(FloatingTaskMonitor, { sessionId, monitor: currentMonitor, prefs, setPrefs: updatePrefs, themeMode, toggleTheme, onOpen: () => setIsOpen(true) }))
      );
    }

    // 输入框模型选择旁边：BOSS直派胶囊开关（显示“开关”二字，开启时胶囊滑块激活）
    function AutopilotInputSwitch({ sessionId }) {
      const [monitor, setMonitor] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      React.useEffect(() => sessionId ? subscribeView(sessionId, 5000, setMonitor) : undefined, [sessionId]);
      const config = monitor?.sessionId === sessionId ? monitor.data?.config : null;
      const active = config?.autopilot === true;
      return React.createElement('button', {
        type: 'button', role: 'switch', 'aria-label': '全自动托管开关', 'aria-checked': active,
        disabled: busy || !config, title: error || '当前会话：主控自主规划、并行派发、审查并继续下一步，无需常规计划审批；安全限制仍有效',
        onClick: async e => {
          e.preventDefault(); e.stopPropagation(); if (busy || !config) return;
          setBusy(true); setError('');
          try {
            const latest = await (await fetch(`/api/lead-worker/view?sessionId=${encodeURIComponent(sessionId)}`)).json();
            if (!latest.ok) throw new Error(latest.error || '无法读取最新配置');
            const nextAutopilot = latest.config.autopilot !== true;
            const nextConfig = { ...latest.config, autopilot: nextAutopilot };
            const res = await fetch('/api/lead-worker/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, action: 'configureSession', autopilot: nextAutopilot, expectedConfigRevision: latest.configRevision }) });
            const result = await res.json();
            if (!result.ok) throw new Error(result.error || '切换失败');
            setMonitor(prev => prev?.sessionId === sessionId ? { ...prev, data: { ...prev.data, config: result.result?.config || nextConfig } } : prev);
            viewStreams.get(sessionId)?.refresh?.();
          } catch (err) { setError(err.message); }
          finally { setBusy(false); }
        },
        style: { display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 8px 0 10px', borderRadius: 12, fontSize: 11, fontWeight: 600, cursor: busy ? 'wait' : 'pointer', border: active ? '1px solid rgba(41,121,237,0.45)' : '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.15))', backgroundColor: active ? 'rgba(41,121,237,0.12)' : 'var(--dsw-alias-bg-module, rgba(0,0,0,0.04))', color: active ? '#2979ed' : 'var(--dsw-alias-label-secondary, #6e6e73)', boxShadow: active ? '0 1px 2px rgba(41,121,237,0.15)' : 'none', transition: 'all 0.2s cubic-bezier(0.4,0,0.2,1)', marginRight: 6, flexShrink: 0, userSelect: 'none' }
      }, React.createElement('span', { style: { letterSpacing: '0.2px' } }, busy ? '切换中…' : '⚡ 全自动托管'),
        React.createElement('span', { 'aria-hidden': true, style: { display: 'inline-flex', alignItems: 'center', width: 24, height: 13, borderRadius: 7, backgroundColor: active ? '#2979ed' : 'rgba(120,120,128,0.3)', position: 'relative', transition: 'background-color 0.2s ease', flexShrink: 0 } },
          React.createElement('span', { style: { display: 'block', width: 9, height: 9, borderRadius: '50%', backgroundColor: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.25)', transform: active ? 'translateX(13px)' : 'translateX(2px)', transition: 'transform 0.2s cubic-bezier(0.4,0,0.2,1)' } })),
        error && React.createElement('span', { role: 'alert' }, `：${error}`));
    }
    function BossDirectInputSwitch({ sessionId }) {
      const [monitor, setMonitor] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [switchError, setSwitchError] = React.useState('');

      React.useEffect(() => {
        if (!sessionId) return;
        return subscribeView(sessionId, 5000, setMonitor);
      }, [sessionId]);

      const currentConfig = monitor?.sessionId === sessionId ? monitor.data?.config : null;
      const isBossDirect = currentConfig ? isBossDirectActive(currentConfig) : false;

      return React.createElement(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': isBossDirect,
          'aria-label': 'BOSS直派开关',
          disabled: loading || !currentConfig,
          onClick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (loading || !currentConfig) return;
            setLoading(true);
            setSwitchError('');
            toggleBossDirectQuick(
              sessionId,
              monitor?.data?.config,
              (_active, config) => { setMonitor(prev => prev ? { ...prev, data: { ...prev.data, config } } : prev); setLoading(false); },
              err => { setSwitchError(err.message); setLoading(false); }
            );
          },
          title: isBossDirect
            ? 'BOSS直派开关：已开启（无论是单任务还是多任务均强制分配子模型干活，主模型负责检查）。点击关闭'
            : 'BOSS直派开关：已关闭。点击开启（无论是单任务还是多任务均先分配子模型干活，主模型负责检查）',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            height: '24px',
            padding: '0 8px 0 10px',
            borderRadius: '12px',
            fontSize: '11px',
            fontWeight: '600',
            cursor: loading ? 'wait' : 'pointer',
            border: isBossDirect ? '1px solid rgba(52, 199, 89, 0.45)' : '1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.15))',
            backgroundColor: isBossDirect ? 'rgba(52, 199, 89, 0.12)' : 'var(--dsw-alias-bg-module, rgba(0, 0, 0, 0.04))',
            color: isBossDirect ? '#248a3d' : 'var(--dsw-alias-label-secondary, #6e6e73)',
            boxShadow: isBossDirect ? '0 1px 2px rgba(52, 199, 89, 0.15)' : 'none',
            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
            marginRight: '6px',
            flexShrink: 0,
            userSelect: 'none',
          }
        },
        React.createElement('span', { style: { letterSpacing: '0.2px' } }, '👔 BOSS直派开关'),
        switchError && React.createElement('span', { role: 'alert' }, switchError),
        // 胶囊滑槽 Track
        React.createElement(
          'span',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              width: '24px',
              height: '13px',
              borderRadius: '7px',
              backgroundColor: isBossDirect ? '#34c759' : 'rgba(120, 120, 128, 0.3)',
              position: 'relative',
              transition: 'background-color 0.2s ease',
              flexShrink: 0,
            }
          },
          // 胶囊滑块 Thumb
          React.createElement('span', {
            style: {
              display: 'block',
              width: '9px',
              height: '9px',
              borderRadius: '50%',
              backgroundColor: '#ffffff',
              boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
              transform: isBossDirect ? 'translateX(13px)' : 'translateX(2px)',
              transition: 'transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
            }
          })
        )
      );
    }

    function apply(ctx) {
      // 1. 全局 CSS 修复：彻底解决对话首页或原生背景下“白底白字”看不到入口的问题
      if (typeof document !== 'undefined') {
        const styleId = 'dsh-lead-worker-global-high-contrast';
        let styleTag = document.getElementById(styleId);
        if (!styleTag) {
          styleTag = document.createElement('style');
          styleTag.id = styleId;
          styleTag.textContent = `
            /* 强制保障外部按钮在无论深色还是白色 DSH 界面下，都文字深黑清晰可见 */
            button[title*="BOSS直派"],
            button[title*="主从协作团队"] {
              color: var(--dsw-alias-label-primary, #1d1d1f) !important;
              background: var(--dsw-alias-bg-base, #ffffff) !important;
              border: 1px solid var(--dsw-alias-border-l2, #d2d2d7) !important;
              box-shadow: 0 1px 3px rgba(0,0,0,0.08) !important;
            }
            button[title*="BOSS直派"]:hover,
            button[title*="主从协作团队"]:hover {
              background: var(--dsw-alias-interactive-bg-hover, #f5f5f7) !important;
            }

            /* 原生 Agent Team 文本清晰度强化 */
            [class*="VoX2oq_trigger"] {
              color: var(--dsw-alias-label-primary, #1d1d1f) !important;
            }
          `;
          document.head.appendChild(styleTag);
        }
      }

      // 2. 在会话顶部导航注册「👔 BOSS直派」按钮
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.actions',
            id: 'lead-worker',
            order: -18,
            inject: (sessionId) => ({ sessionId }),
          },
          LeadWorkerAction
        )
      );

      // 3. 在首页操作区注册「👔 BOSS直派」按钮
      ctx.slots.inject('conversation.hero.modeActions', () =>
        ctx.slots.register(
          {
            name: 'conversation.hero.modeActions',
            id: 'lead-worker-hero',
            order: -18,
            inject: (sessionId) => ({ sessionId }),
          },
          LeadWorkerAction
        )
      );

      // 4. 在对话界面输入框模型选择旁边注册「👔 BOSS直派」开关（带 BOSS 徽章）
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.right',
            id: 'lead-worker-boss-direct-input',
            order: 10,
            inject: (sessionId) => ({ sessionId }),
          },
          BossDirectInputSwitch
        )
      );
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right', id: 'lead-worker-autopilot-input', order: 11,
        inject: sessionId => ({ sessionId })
      }, AutopilotInputSwitch));
    }

    const inject = ['slots'];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
