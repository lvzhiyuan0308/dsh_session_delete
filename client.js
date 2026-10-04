window.__ModuleLoader__.load({ id: 'dsh_session_delete', factory(require) {
  const React = require('react');
  const { MenuItemButton, Modal, Button } = require('@deepseek-ai/dsh-client-ui-primitives');
  const h = React.createElement;

  return {
    name: 'dsh_session_delete-client',
    inject: ['slots', 'uiWorkspace', 'sessions'],
    apply(ctx) {
      let target = null;
      const listeners = new Set();
      const publish = value => { target = value; for (const listener of listeners) listener(); };
      function DeleteRow({ sessionId, displayTitle, useMenuOpenState }) {
        const [, setMenuOpen] = useMenuOpenState();
        return h(MenuItemButton, {
          danger: true, separatorBefore: true,
          onSelect() { setMenuOpen(false); publish({ sessionId, displayTitle }); },
        }, '删除此对话');
      }
      function Confirmation() {
        const value = React.useSyncExternalStore(
          React.useCallback(listener => { listeners.add(listener); return () => listeners.delete(listener); }, []),
          () => target,
        );
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState('');
        React.useEffect(() => setError(''), [value]);
        const close = () => { if (!busy) publish(null); };
        async function confirm() {
          if (busy || !value) return;
          setBusy(true);
          setError('');
          const list = ctx.sessions.list.getSnapshot();
          const wasCurrent = (list.byId[value.sessionId]?.retainedBy.mainView ?? 0) > 0;
          try {
            const response = await fetch('/api/dsh_session_delete', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: value.sessionId, confirmed: true }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '删除失败');
            ctx.sessions.handleSessionRemoved(value.sessionId);
            publish(null);
            if (wasCurrent) ctx.uiWorkspace.startSession();
          } catch (failure) {
            setError(failure.message || '删除失败，请重试');
          } finally { setBusy(false); }
        }
        return h(Modal, {
          open: !!value, onClose: close, title: '删除此对话', closeLabel: '关闭',
          description: `确定删除「${value?.displayTitle || '未命名会话'}」吗？删除后无法恢复。`,
          footer: h(React.Fragment, null,
            h(Button, { onClick: close, disabled: busy, 'data-modal-autofocus': true }, '取消'),
            h(Button, { variant: 'primary', onClick: confirm, disabled: busy }, busy ? '删除中…' : '删除'),
          ),
        }, error ? h('p', { role: 'alert', style: { color: 'var(--dsw-alias-text-error, #c53030)' } }, error) : null);
      }
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register(
        { name: 'sidebar.workspaces.session.menu.item', id: 'dsh_session_delete:delete', order: 500 }, DeleteRow,
      ));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'dsh_session_delete:confirmation', order: 500 }, Confirmation,
      ));
    },
  };
} });
