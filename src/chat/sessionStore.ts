import type { DataAdapter } from "obsidian";
import { ChatSession, SessionInfo, normalizeSession, randomId, validSessionId } from "./session";
import { type Clock, compareClocks, mergeClocks, mergeSessions, parseClock, tick } from "./sessionMerge";

// 本机快照与主文件一致后再保留这么久，用来找回同步工具按「后写覆盖」丢掉的并发写入。
const SNAPSHOT_KEEP_MS = 14 * 24 * 60 * 60 * 1000;

function contentSignature(session: ChatSession): string {
  // 输入防抖会更新日期；仅日期变化不算未保存内容，也不能覆盖远端的新消息。
  const { updatedAt: _updatedAt, ...content } = session;
  return JSON.stringify(content);
}

// 仅用于 0.6.2 留下的快照：它们没有版本向量，只能按内容判断是否已写进主文件。
function containsSnapshot(current: ChatSession, snapshot: ChatSession): boolean {
  if (snapshot.history.length > current.history.length) return false;
  if (!snapshot.history.every((m, i) => m.role === current.history[i].role && m.content === current.history[i].content)) return false;
  if (snapshot.history.length === current.history.length) return contentSignature(snapshot) === contentSignature(current);
  return !snapshot.composer || snapshot.composer === current.composer
    || current.history.slice(snapshot.history.length).some(m => m.role === "user" && m.content === snapshot.composer.trim());
}

const clone = (session: ChatSession): ChatSession => JSON.parse(JSON.stringify(session)) as ChatSession;

interface StoredSession { session: ChatSession; clock: Clock; legacy: boolean }

export class SessionStore {
  private infos = new Map<string, SessionInfo>();
  private cache = new Map<string, ChatSession>();
  private deleted = new Set<string>();
  // 本机上次读到或写入的磁盘版本，作为三方合并的基准。
  private versions = new Map<string, { disk: string | null; content: string; clock: Clock }>();
  private queue: Promise<void> = Promise.resolve();
  private pending: Promise<void> = Promise.resolve();
  readonly warnings: string[] = [];

  constructor(
    private adapter: DataAdapter, private dir: string, private onWarning?: (message: string) => void,
    private onChanged?: (session: ChatSession, previousId: string) => void,
    // 快照只由写下它的设备判断是否丢失，标识需要跨重启保持不变，见 main.ts。
    private deviceId = randomId("device"),
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
    if (cached) { await this.reconcile(cached); return cached; }
    const session = await this.read(id);
    this.remember(session);
    return session;
  }
  // 把其它设备的更新接进内存中的会话，不写盘；本机未保存的改动保留，下一次保存时一并写入。
  // 无法自动合并时保持原样，交给下一次保存另存副本。
  reconcile(session: ChatSession): Promise<void> {
    return this.enqueue(async () => {
      const id = session.id, version = this.versions.get(id);
      if (!version || this.deleted.has(id)) return;
      const disk = await this.readText(this.path(id));
      if (disk === version.disk || disk === null) return;
      const remote = this.parseFile(disk, id);
      const next = remote && this.combine(clone(session), remote.session, version);
      if (!remote || !next) return;
      this.versions.set(id, { disk, content: contentSignature(remote.session), clock: remote.clock });
      this.apply(session, next, id);
    });
  }
  save(session: ChatSession): Promise<void> {
    if (!validSessionId(session.id)) return Promise.reject(new Error("会话标识无效。"));
    if (this.deleted.has(session.id)) return Promise.reject(new Error("这段会话已删除。"));
    this.remember(session);
    return this.enqueue(async () => {
      // 排在前面的保存可能已把会话分流到新标识，按执行时的标识写入。
      const id = session.id;
      if (this.deleted.has(id)) return;
      const disk = await this.readText(this.path(id));
      // 从这里到开始写入之间没有等待：读取的就是要写入的状态，期间的输入不会被覆盖。
      const local = clone(session);
      const version = this.versions.get(id);
      if (version ? disk === version.disk : disk === null) {
        await this.writeSession(local, tick(version?.clock ?? {}, this.deviceId));
        await this.saveIndex(this.info(local));
        return;
      }
      const remote = this.parseFile(disk, id);
      const next = remote && version ? this.combine(local, remote.session, version) : null;
      if (!remote || !version || !next) { await this.fork(session, local, id, remote, disk); return; }
      this.apply(session, next, id);
      if (contentSignature(next) === contentSignature(remote.session)) {
        // 本机的改动都已在磁盘版本里，接上即可，不必再写。
        this.versions.set(id, { disk, content: contentSignature(remote.session), clock: remote.clock });
        return;
      }
      await this.writeSession(next, tick(mergeClocks(version.clock, remote.clock), this.deviceId));
      await this.saveIndex(this.info(next));
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
  private snapshotPath(id: string): string { return `${this.dir}/recovery/${id}.${this.deviceId}.json`; }
  // 本机没有改动时直接采用磁盘版本，否则以上次读写的版本为基准做三方合并。
  private combine(local: ChatSession, remote: ChatSession, version: { disk: string | null; content: string }): ChatSession | null {
    if (contentSignature(local) === version.content) return remote;
    return mergeSessions(this.parseFile(version.disk, local.id)?.session ?? null, local, remote);
  }
  private apply(session: ChatSession, next: ChatSession, previousId: string): void {
    const changed = contentSignature(session) !== contentSignature(next);
    Object.assign(session, clone(next));
    this.remember(session);
    if (changed) this.onChanged?.(session, previousId);
  }
  // 两边的改动无法自动合并：本机内容另存为副本，原会话保留磁盘上的版本，双方都不丢。
  private async fork(session: ChatSession, local: ChatSession, id: string, remote: StoredSession | null, disk: string | null): Promise<void> {
    const fork = { ...local, id: randomId("chat"), title: `${local.title.replace(/ · 同步副本$/, "")} · 同步副本` };
    await this.writeSession(fork, tick({}, this.deviceId));
    const own = this.snapshotPath(id);
    if (await this.adapter.exists(own)) await this.adapter.remove(own);
    if (remote) {
      this.cache.set(id, remote.session); this.infos.set(id, this.info(remote.session));
      this.versions.set(id, { disk, content: contentSignature(remote.session), clock: remote.clock });
    } else { this.cache.delete(id); this.infos.delete(id); this.versions.delete(id); }
    // 只改身份信息；入队之后新输入的草稿仍属于这个活的会话对象。
    session.id = fork.id; session.title = fork.title;
    this.remember(session);
    this.onChanged?.(session, id);
    await this.saveIndex(this.info(fork));
    this.warn(`会话「${local.title}」在其它设备有无法自动合并的改动。本机内容已保存为「${fork.title}」，双方记录均保留。`);
  }
  private async read(id: string): Promise<ChatSession> {
    const path = this.path(id);
    const primary = await this.readText(path);
    for (const candidate of [path, `${path}.bak`]) {
      try {
        const file = this.parseFile(candidate === path ? primary : await this.readText(candidate), id);
        if (file) {
          this.versions.set(id, { disk: primary, content: contentSignature(file.session), clock: file.clock });
          if (candidate !== path) this.warn(`会话「${file.session.title}」已从备份恢复。`);
          return file.session;
        }
      } catch { /* 保留损坏原文件，继续尝试上一次成功写入的备份。 */ }
    }
    throw new Error("会话文件无法读取，原文件已保留。");
  }
  private async readText(path: string): Promise<string | null> {
    return await this.adapter.exists(path) ? this.adapter.read(path) : null;
  }
  private parseFile(text: string | null, id?: string): StoredSession | null {
    if (text === null) return null;
    try {
      const raw: unknown = JSON.parse(text);
      const session = normalizeSession(raw);
      if (!session || (id && session.id !== id)) return null;
      const fields = raw as Record<string, unknown>;
      return { session, clock: parseClock(fields.clock), legacy: !("clock" in fields) };
    } catch { return null; }
  }
  private async writeSession(snapshot: ChatSession, clock: Clock): Promise<void> {
    const text = JSON.stringify({ ...snapshot, clock });
    const recovery = `${this.dir}/recovery`;
    if (!await this.adapter.exists(recovery)) await this.adapter.mkdir(recovery);
    // Adapter 没有跨设备的原子比较并写入。每台设备先留一份自己的快照：写入中断，
    // 或同步工具按「后写覆盖」丢掉这次写入时，本机重启后据此找回。
    await this.adapter.write(this.snapshotPath(snapshot.id), text);
    await this.writeRecoverable(this.path(snapshot.id), text);
    this.versions.set(snapshot.id, { disk: text, content: contentSignature(snapshot), clock });
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
  // 每台设备只判断自己写下的快照是否丢失。别的设备的快照可能比主文件先同步到，
  // 替它判断会把还在路上的写入当成丢失，生成重复副本；已被后来写入包含的快照谁都可以清理。
  private async restoreRecovery(): Promise<void> {
    const recovery = `${this.dir}/recovery`;
    if (!await this.adapter.exists(recovery)) return;
    for (const path of (await this.adapter.list(recovery)).files) {
      const name = /\/([a-zA-Z0-9_-]{1,100})\.([a-zA-Z0-9_-]{1,100})\.json$/.exec(path);
      const snapshot = name ? this.parseFile(await this.readText(path), name[1]) : null;
      if (!name || !snapshot) continue;
      const [, id, writer] = name;
      const mainText = await this.readText(this.path(id));
      const main = this.parseFile(mainText, id);
      if (snapshot.legacy) {
        if (!main || !containsSnapshot(main.session, snapshot.session)) await this.keepRecoveryCopy(snapshot.session);
        await this.adapter.remove(path);
        continue;
      }
      // 0.6.2 写回的主文件没有版本向量，排不出先后，按并发处理，避免用本机旧快照覆盖它的新内容。
      const order = !main ? null : main.legacy ? "concurrent" : compareClocks(snapshot.clock, main.clock);
      if (order === "before") { await this.adapter.remove(path); continue; }
      if (writer !== this.deviceId) continue;
      if (order === "equal") {
        if (Date.now() - snapshot.session.updatedAt > SNAPSHOT_KEEP_MS) await this.adapter.remove(path);
        continue;
      }
      if (order === "after" || (!main && mainText !== null)) {
        // 本机的写入没有落到主文件（写入中断、被同步回滚或主文件损坏），补写回原会话。
        await this.writeSession(snapshot.session, snapshot.clock);
        this.remember(snapshot.session);
        await this.saveIndex(this.info(snapshot.session));
        continue;
      }
      // 主文件已被删除，或被并发写入覆盖：能合并就写回原会话，已包含在主文件里就只清理快照，否则另存为恢复副本。
      const merged = main && mergeSessions(null, snapshot.session, main.session);
      if (main && merged && contentSignature(merged) === contentSignature(main.session)) { await this.adapter.remove(path); continue; }
      if (main && merged) {
        await this.writeSession(merged, tick(mergeClocks(snapshot.clock, main.clock), this.deviceId));
        this.remember(merged);
        await this.saveIndex(this.info(merged));
        continue;
      }
      await this.keepRecoveryCopy(snapshot.session);
      await this.adapter.remove(path);
    }
  }
  private async keepRecoveryCopy(snapshot: ChatSession): Promise<void> {
    const fork = { ...snapshot, id: randomId("chat"), title: `${snapshot.title} · 恢复副本` };
    await this.writeSession(fork, tick({}, this.deviceId));
    this.remember(fork);
    await this.saveIndex(this.info(fork));
    this.warn(`会话「${snapshot.title}」有未写进主文件的内容，已保留为「${fork.title}」。`);
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
