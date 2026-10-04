import { readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

export const name = 'dsh_session_delete';
export const inject = ['connection', 'agentLoop', 'agents', 'sessions', 'sessionPersistence', 'workspaceRegistry'];

export function apply(ctx) {
  const storage = ctx.sessionPersistence;
  const loop = ctx.agentLoop;
  const workspaces = ctx.workspaceRegistry;
  // rc.2 has no deletion API. These two internal seams are version-specific.
  if (storage.name !== 'session-persistence-jsonl' || typeof storage.findLog !== 'function'
      || typeof storage.acquireLease !== 'function' || typeof loop.prepare !== 'function') {
    throw new Error('dsh_session_delete requires DSH 0.2.0-rc.2 with JSONL persistence');
  }
  const lifetimes = new Map();
  const deleting = new Set();
  const prepare = loop.prepare;
  ctx.effect(() => {
    const wrapped = function (...args) {
      const id = args[1];
      if (deleting.has(id)) throw new Error('该会话正在删除');
      const lifetime = prepare.apply(this, args);
      lifetimes.set(id, { session: args[3], dispose: lifetime.dispose });
      return lifetime;
    };
    loop.prepare = wrapped;
    return () => {
      if (loop.prepare === wrapped) loop.prepare = prepare;
      lifetimes.clear();
    };
  });
  ctx.on('session/disposed', session => {
    if (lifetimes.get(session.id)?.session === session) lifetimes.delete(session.id);
  });

  async function deleteSession(id) {
    if (typeof id !== 'string' || !id || id.length > 256) throw new Error('无效的会话 ID');
    if (deleting.has(id)) throw new Error('该会话正在删除');
    const live = ctx.sessions.get(id);
    const header = live?.header ?? (await storage.stat(id))?.header;
    if (!header) throw new Error('会话不存在');
    if (header.origin === 'subagent') throw new Error('请选择侧栏中的普通会话');
    const lifetime = lifetimes.get(id);
    if (live && lifetime?.session !== live) throw new Error('请重启 DSH 后再删除此会话');
    const wasArchived = workspaces.archivedSessionIds.includes(id);
    const wasPinned = workspaces.pinnedSessionIds.includes(id);
    if (deleting.has(id)) throw new Error('该会话正在删除');
    deleting.add(id);
    let erased = false;
    try {
      // Archive admission blocks new turns while the normal teardown drains writes.
      await workspaces.archiveSession(id, { stopActivity: true });
      if (wasArchived) await ctx.parallel('workspace/session-stop', { sessionId: id });
      await lifetime?.dispose();
      lifetimes.delete(id);
      if (ctx.sessions.get(id) || ctx.agents.get(id)) throw new Error('会话仍被占用，请稍后重试');
      const activity = await ctx.waterfall('workspace/session-activity', { sessionId: id }, async () => []);
      if (activity.length) throw new Error('会话仍有后台任务，请稍后重试');

      const selected = await storage.findLog(id);
      if (selected) {
        const dir = await realpath(path.dirname(selected.sourcePath));
        const root = await realpath(storage.config.root);
        const relative = path.relative(root, dir);
        // Verify the actual path is one session directory under the configured root.
        if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes('..')
            || relative.split(path.sep).length !== 2) throw new Error('会话存储路径不合法');
        const lease = await storage.acquireLease(id, header.cwd, dir);
        try {
          const entries = (await readdir(dir, { withFileTypes: true })).filter(e => e.name !== 'session.lock');
          if (entries.some(e => !e.isFile())) throw new Error('会话目录包含未知文件，请检查后重试');
          // Remove historical generations first, keeping the current log until last.
          const current = path.basename(selected.sourcePath);
          entries.sort((a, b) => Number(a.name === current) - Number(b.name === current));
          for (const entry of entries) await rm(path.join(dir, entry.name));
        } finally {
          // Keep the stable lock file: removing it can race another DSH writer.
          await lease.release();
        }
      }
      erased = true;
      storage.coldLogMemo.delete(id);
      for (const workspace of workspaces.list()) await workspace.detachSession(id);
      workspaces.headers.delete(id);
      workspaces.sessionPaths.delete(id);
      workspaces.invalidSessionPaths.delete(id);
      await workspaces.unarchiveSession(id);
      await workspaces.unpinSession(id);
      ctx.emit('api-session/removed', id);
      return { deleted: true };
    } catch (error) {
      if (!erased && !wasArchived) {
        await workspaces.unarchiveSession(id);
        if (wasPinned) await workspaces.pinSession(id);
      }
      throw error;
    } finally {
      deleting.delete(id);
    }
  }

  // DSH's shared API applies authentication and Host/Origin checks.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh_session_delete', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const body = await request.json();
        if (body?.confirmed !== true) throw new Error('请先确认删除');
        return Response.json(await deleteSession(body.sessionId));
      } catch (error) {
        return Response.json({ error: error.message || String(error) }, { status: 400 });
      }
    },
  }));
}
