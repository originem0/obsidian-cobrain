import type { DataAdapter } from "obsidian";
import { ChatSession, SessionInfo, normalizeSession, validSessionId } from "./session";

export class SessionStore {
  private infos = new Map<string, SessionInfo>();
  private cache = new Map<string, ChatSession>();
  private deleted = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private pending: Promise<void> = Promise.resolve();
  readonly warnings: string[] = [];

  constructor(private adapter: DataAdapter, private dir: string, private onWarning?: (message: string) => void) {}
  private warn(message: string): void { this.warnings.push(message); this.onWarning?.(message); }

  async init(): Promise<void> {
    if (!await this.adapter.exists(this.dir)) await this.adapter.mkdir(this.dir);
    const rows = await this.readJson(`${this.dir}/index.json`);
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row && validSessionId(row.id) && typeof row.title === "string"
          && Number.isFinite(row.createdAt) && Number.isFinite(row.updatedAt)) this.infos.set(row.id, row);
      }
    }
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
    if (cached) return cached;
    const session = await this.read(id);
    this.remember(session);
    return session;
  }
  save(session: ChatSession): Promise<void> {
    if (!validSessionId(session.id)) return Promise.reject(new Error("会话标识无效。"));
    if (this.deleted.has(session.id)) return Promise.reject(new Error("这段会话已删除。"));
    this.remember(session);
    // 入队时冻结数据，后续输入或另一轮回答不能串入尚未完成的文件写入。
    const snapshot = JSON.stringify(session);
    const info = this.info(session);
    return this.enqueue(async () => {
      if (this.deleted.has(info.id)) return;
      await this.writeRecoverable(this.path(info.id), snapshot);
      await this.writeRecoverable(`${this.dir}/index.json`, JSON.stringify(this.list()));
    });
  }
  delete(id: string): Promise<void> {
    if (!validSessionId(id)) return Promise.reject(new Error("会话标识无效。"));
    this.deleted.add(id);
    return this.enqueue(async () => {
      // 用户确认删除后才移除文件；后台迟到的保存不能重建已经删除的会话。
      for (const path of [this.path(id), `${this.path(id)}.bak`]) {
        if (await this.adapter.exists(path)) await this.adapter.remove(path);
      }
      this.infos.delete(id);
      this.cache.delete(id);
      await this.writeRecoverable(`${this.dir}/index.json`, JSON.stringify(this.list()));
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
    for (const candidate of [path, `${path}.bak`]) {
      try {
        if (!await this.adapter.exists(candidate)) continue;
        const session = normalizeSession(JSON.parse(await this.adapter.read(candidate)));
        if (session?.id === id) {
          if (candidate !== path) this.warn(`会话「${session.title}」已从备份恢复。`);
          return session;
        }
      } catch { /* 保留损坏原文件，继续尝试上一次成功写入的备份。 */ }
    }
    throw new Error("会话文件无法读取，原文件已保留。");
  }
  private async readJson(path: string): Promise<unknown> {
    for (const candidate of [path, `${path}.bak`]) {
      try { if (await this.adapter.exists(candidate)) return JSON.parse(await this.adapter.read(candidate)); }
      catch { /* 元数据可从会话文件恢复。 */ }
    }
    return null;
  }
  private async writeRecoverable(path: string, text: string): Promise<void> {
    // DataAdapter 的覆盖写在各设备上并不保证原子性，保留上一份可解析数据后才写新内容。
    if (await this.adapter.exists(path)) {
      const previous = await this.adapter.read(path);
      let valid = false;
      try {
        const parsed = JSON.parse(previous);
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
