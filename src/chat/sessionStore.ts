import type { DataAdapter } from "obsidian";
import { ChatSession, SessionInfo, newSession, normalizeSession, validSessionId } from "./session";

function contentSignature(session: ChatSession): string {
  // 输入防抖会更新日期；仅日期变化不算未保存内容，也不能覆盖远端的新消息。
  const { updatedAt: _updatedAt, ...content } = session;
  return JSON.stringify(content);
}

function containsSnapshot(current: ChatSession, snapshot: ChatSession): boolean {
  if (snapshot.history.length > current.history.length) return false;
  if (!snapshot.history.every((m, i) => m.role === current.history[i].role && m.content === current.history[i].content)) return false;
  if (snapshot.history.length === current.history.length) return contentSignature(snapshot) === contentSignature(current);
  return !snapshot.composer || snapshot.composer === current.composer
    || current.history.slice(snapshot.history.length).some(m => m.role === "user" && m.content === snapshot.composer.trim());
}

export class SessionStore {
  private infos = new Map<string, SessionInfo>();
  private cache = new Map<string, ChatSession>();
  private deleted = new Set<string>();
  private versions = new Map<string, { disk: string | null; content: string }>();
  private writerId = newSession().id;
  private queue: Promise<void> = Promise.resolve();
  private pending: Promise<void> = Promise.resolve();
  readonly warnings: string[] = [];

  constructor(
    private adapter: DataAdapter, private dir: string, private onWarning?: (message: string) => void,
    private onChanged?: (session: ChatSession, previousId: string) => void,
  ) {}
  private warn(message: string): void { this.warnings.push(message); this.onWarning?.(message); }

  async init(): Promise<void> {
    if (!await this.adapter.exists(this.dir)) await this.adapter.mkdir(this.dir);
    await this.refresh();
    await this.restoreRecovery();
  }

  async refresh(): Promise<void> {
    await this.queue;
    for (const info of await this.readIndex()) this.infos.set(info.id, info);
    const files = (await this.adapter.list(this.dir)).files;
    const ids = new Set(files.map(f => f.split("/").pop() ?? "")
      .filter(f => !/^index\.json(?:\.bak)?$/.test(f) && /\.json(?:\.bak)?$/.test(f))
      .map(f => f.replace(/\.json(?:\.bak)?$/, "")).filter(validSessionId));
    for (const id of this.infos.keys()) if (!ids.has(id)) this.infos.delete(id);
    // 会话先写、目录后写；恢复中断在两次写入之间的新会话，索引损坏时也可从原文件重建目录。
    for (const id of ids) {
      if (this.infos.has(id)) continue;
      try { this.remember(await this.read(id)); }
      catch { this.warn(`会话 ${id} 暂时无法读取，原文件已保留。`); }
    }
  }

  list(): SessionInfo[] { return [...this.infos.values()].sort((a, b) => b.updatedAt - a.updatedAt); }
  has(id: string): boolean { return this.infos.has(id); }
  async get(id: string): Promise<ChatSession> {
    if (this.deleted.has(id)) throw new Error("这段会话已删除。");
    const cached = this.cache.get(id);
    if (cached) {
      const version = this.versions.get(id);
      const disk = await this.readText(this.path(id));
      // 有本地未保存内容时先保留它，下一次 save 会把冲突分成两段独立会话。
      if (!version || disk === version.disk || contentSignature(cached) !== version.content) return cached;
      const fresh = await this.read(id);
      Object.assign(cached, fresh);
      this.remember(cached);
      this.onChanged?.(cached, id);
      return cached;
    }
    const session = await this.read(id);
    this.remember(session);
    return session;
  }
  save(session: ChatSession): Promise<void> {
    if (!validSessionId(session.id)) return Promise.reject(new Error("会话标识无效。"));
    if (this.deleted.has(session.id)) return Promise.reject(new Error("这段会话已删除。"));
    this.remember(session);
    // 入队时冻结数据，后续输入或另一轮回答不能串入尚未完成的文件写入。
    const text = JSON.stringify(session);
    return this.enqueue(async () => {
      const snapshot = JSON.parse(text) as ChatSession;
      // 之前排队的保存可能在冲突分流之后才运行，继续写到同一个本地副本。
      if (snapshot.id !== session.id) { snapshot.id = session.id; snapshot.title = session.title; }
      if (this.deleted.has(snapshot.id)) return;
      const id = snapshot.id, path = this.path(id);
      const previous = await this.readText(path);
      const version = this.versions.get(id);
      if (version ? previous !== version.disk : previous !== null) {
        const remote = this.parseSession(previous, id);
        if (remote && version && contentSignature(snapshot) === version.content) {
          Object.assign(session, remote);
          this.versions.set(id, { disk: previous, content: contentSignature(remote) });
          this.remember(session);
          this.onChanged?.(session, id);
          return;
        }
        const fork = { ...snapshot, id: newSession().id, title: `${snapshot.title.replace(/ · 同步副本$/, "")} · 同步副本` };
        await this.writeSnapshot(fork);
        const checkpoint = `${this.dir}/recovery/${id}.${this.writerId}.json`;
        if (await this.adapter.exists(checkpoint)) await this.adapter.remove(checkpoint);
        if (remote) { this.cache.set(id, remote); this.infos.set(id, this.info(remote)); }
        else { this.cache.delete(id); this.infos.delete(id); }
        // 只改身份信息；入队之后新输入的草稿仍属于这个活的会话对象。
        session.id = fork.id; session.title = fork.title;
        this.remember(session);
        this.onChanged?.(session, id);
        await this.saveIndex(this.info(fork));
        this.warn(`会话「${snapshot.title}」已在其它设备更新。本地内容已保存为「${fork.title}」，双方记录均保留。`);
        return;
      }
      await this.writeSnapshot(snapshot);
      await this.saveIndex(this.info(snapshot));
    });
  }
  delete(id: string): Promise<void> {
    if (!validSessionId(id)) return Promise.reject(new Error("会话标识无效。"));
    this.deleted.add(id);
    return this.enqueue(async () => {
      const version = this.versions.get(id);
      if (version && await this.readText(this.path(id)) !== version.disk) {
        throw new Error("会话已在其它设备更新，请重新打开后再删除。");
      }
      // 用户确认删除后才移除文件；后台迟到的保存不能重建已经删除的会话。
      for (const path of [this.path(id), `${this.path(id)}.bak`]) {
        if (await this.adapter.exists(path)) await this.adapter.remove(path);
      }
      this.infos.delete(id);
      this.cache.delete(id);
      this.versions.delete(id);
      const recovery = `${this.dir}/recovery`;
      if (await this.adapter.exists(recovery)) {
        for (const path of (await this.adapter.list(recovery)).files) {
          if (path.split("/").pop()?.startsWith(`${id}.`)) await this.adapter.remove(path);
        }
      }
      await this.saveIndex(undefined, id);
    }).catch(e => { this.deleted.delete(id); throw e; });
  }
  flush(): Promise<void> { return this.pending; }

  private info(s: ChatSession): SessionInfo {
    return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt };
  }
  private remember(s: ChatSession): void { this.cache.set(s.id, s); this.infos.set(s.id, this.info(s)); }
  private path(id: string): string {
    if (!validSessionId(id)) throw new Error("会话标识无效。");
    return `${this.dir}/${id}.json`;
  }
  private async read(id: string): Promise<ChatSession> {
    const path = this.path(id);
    const primary = await this.readText(path);
    for (const candidate of [path, `${path}.bak`]) {
      try {
        const text = candidate === path ? primary : await this.readText(candidate);
        const session = this.parseSession(text, id);
        if (session) {
          this.versions.set(id, { disk: primary, content: contentSignature(session) });
          if (candidate !== path) this.warn(`会话「${session.title}」已从备份恢复。`);
          return session;
        }
      } catch { /* 保留损坏原文件，继续尝试上一次成功写入的备份。 */ }
    }
    throw new Error("会话文件无法读取，原文件已保留。");
  }
  private async readText(path: string): Promise<string | null> {
    return await this.adapter.exists(path) ? this.adapter.read(path) : null;
  }
  private parseSession(text: string | null, id?: string): ChatSession | null {
    try {
      const session = text === null ? null : normalizeSession(JSON.parse(text));
      return session && (!id || session.id === id) ? session : null;
    } catch { return null; }
  }
  private async writeSnapshot(snapshot: ChatSession): Promise<void> {
    const text = JSON.stringify(snapshot);
    const recovery = `${this.dir}/recovery`;
    if (!await this.adapter.exists(recovery)) await this.adapter.mkdir(recovery);
    // Adapter 没有跨设备的原子比较并写入。每个运行实例先留一份独立快照，
    // 即使两个写入同时通过版本检查，重启后也能找回被覆盖的一方。
    await this.adapter.write(`${recovery}/${snapshot.id}.${this.writerId}.json`, text);
    await this.writeRecoverable(this.path(snapshot.id), text);
    this.versions.set(snapshot.id, { disk: text, content: contentSignature(snapshot) });
  }
  private async saveIndex(changed?: SessionInfo, removed?: string): Promise<void> {
    const merged = new Map<string, SessionInfo>();
    for (const info of await this.readIndex()) merged.set(info.id, info);
    for (const info of this.infos.values()) if (!merged.has(info.id)) merged.set(info.id, info);
    if (changed) merged.set(changed.id, changed);
    if (removed) merged.delete(removed);
    await this.writeRecoverable(`${this.dir}/index.json`, JSON.stringify([...merged.values()]));
    for (const info of merged.values()) this.infos.set(info.id, info);
  }
  private async restoreRecovery(): Promise<void> {
    const recovery = `${this.dir}/recovery`;
    if (!await this.adapter.exists(recovery)) return;
    for (const path of (await this.adapter.list(recovery)).files) {
      if (!path.endsWith(".json")) continue;
      const snapshot = this.parseSession(await this.readText(path));
      if (!snapshot) continue;
      const current = this.parseSession(await this.readText(this.path(snapshot.id)), snapshot.id);
      if (!current || !containsSnapshot(current, snapshot)) {
        const fork = { ...snapshot, id: newSession().id, title: `${snapshot.title} · 恢复副本` };
        await this.writeSnapshot(fork);
        this.remember(fork);
        await this.saveIndex(this.info(fork));
        this.warn(`会话「${snapshot.title}」存在未合并的恢复快照，已保留为「${fork.title}」。`);
      }
      // 原会话已包含全部消息和草稿，或恢复副本已写入成功，才清理这份快照。
      await this.adapter.remove(path);
    }
  }
  private async readJson(path: string): Promise<unknown> {
    for (const candidate of [path, `${path}.bak`]) {
      try { if (await this.adapter.exists(candidate)) return JSON.parse(await this.adapter.read(candidate)); }
      catch { /* 元数据可从会话文件恢复。 */ }
    }
    return null;
  }
  // 目录可能来自另一台设备或旧版本，只取有效行的四个字段，其余字段不再写回。
  private async readIndex(): Promise<SessionInfo[]> {
    const rows = await this.readJson(`${this.dir}/index.json`);
    const list: unknown[] = Array.isArray(rows) ? rows : [];
    const infos: SessionInfo[] = [];
    for (const row of list) {
      if (!row || typeof row !== "object") continue;
      const { id, title, createdAt, updatedAt } = row as Record<string, unknown>;
      if (validSessionId(id) && typeof title === "string" && typeof createdAt === "number" && Number.isFinite(createdAt)
        && typeof updatedAt === "number" && Number.isFinite(updatedAt)) infos.push({ id, title, createdAt, updatedAt });
    }
    return infos;
  }
  private async writeRecoverable(path: string, text: string): Promise<void> {
    // DataAdapter 的覆盖写在各设备上并不保证原子性，保留上一份可解析数据后才写新内容。
    if (await this.adapter.exists(path)) {
      const previous = await this.adapter.read(path);
      let valid = false;
      try {
        const parsed: unknown = JSON.parse(previous);
        valid = path.endsWith("/index.json") ? Array.isArray(parsed) : normalizeSession(parsed) !== null;
      } catch { /* 损坏的主文件不能覆盖上一次可用的备份。 */ }
      if (valid) await this.adapter.write(`${path}.bak`, previous);
    }
    await this.adapter.write(path, text);
  }
  private enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.queue.then(op);
    this.pending = run;
    this.queue = run.catch(() => undefined);
    return run;
  }
}
