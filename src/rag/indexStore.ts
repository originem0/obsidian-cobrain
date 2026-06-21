import { App, PluginManifest, Platform, normalizePath } from "obsidian";
import { VectorStore } from "./vectorStore";
import { fnv1a64 } from "../util/hash";

// 索引分片持久化：index/<hash64(path)>.json 每篇一片 + index/meta.json({v,embedModel})。
// 改一篇只写它的分片(消灭整份重写)；移动端只读——所有写方法 no-op，杜绝双写冲突。
const META = "meta.json";
const SHARD_V = 3;

export class IndexStore {
  constructor(
    private app: App,
    private manifest: PluginManifest,
    private store: VectorStore,
    private readOnly = Platform.isMobile,
  ) {}

  private get adapter() { return this.app.vault.adapter; }
  private base(): string { return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`; }
  private dir(): string { return normalizePath(`${this.base()}/index`); }
  private metaPath(): string { return normalizePath(`${this.dir()}/${META}`); }
  private legacyPath(): string { return normalizePath(`${this.base()}/index.json`); }
  private shardName(path: string): string { return `${fnv1a64(path)}.json`; }
  private shardPath(path: string): string { return normalizePath(`${this.dir()}/${this.shardName(path)}`); }

  // 启动加载：优先 index/ 分片；否则迁移旧 index.json；返回存储的 embedModel(换模型检测用)。
  async load(opts: { legacyDataIndex?: unknown; onMigratedLegacyDataIndex?: () => Promise<void> } = {}): Promise<string | undefined> {
    if (await this.adapter.exists(this.dir())) {
      let embedModel: string | undefined;
      const listed = await this.adapter.list(this.dir());
      const shards: string[] = [];
      for (const f of listed.files) {
        const name = f.split("/").pop() ?? "";
        if (name === META) {
          try {
            const parsed: unknown = JSON.parse(await this.adapter.read(f));
            embedModel = (parsed && typeof parsed === "object" && "embedModel" in parsed && typeof parsed.embedModel === "string")
              ? parsed.embedModel : undefined;
          } catch { /* 坏 meta 忽略 */ }
          continue;
        }
        if (name.endsWith(".json")) shards.push(f);
      }
      // 并行读分片：数百个文件串行 await 会拖慢加载（且这一步在 onload 之外后台跑）。读完再逐个反序列化进 store。
      const contents = await Promise.all(
        shards.map(f => this.adapter.read(f).then(
          txt => ({ f, txt }),
          e => { console.error("Cobrain: 分片读取失败", f, e); return null; },
        )),
      );
      for (const c of contents) {
        if (!c) continue;
        try { this.store.deserializeFile(JSON.parse(c.txt)); }
        catch (e) { console.error("Cobrain: 分片解析失败", c.f, e); }
      }
      return embedModel;
    }
    // 迁移：旧单文件 index.json → 分片(首次加载一次性)。早于 #1 的 data.json.index 不再处理(那类装机早已迁移)。
    if (await this.adapter.exists(this.legacyPath())) {
      try {
        const payload: unknown = JSON.parse(await this.adapter.read(this.legacyPath()));
        // deserialize 期望特定形状，验证后传入
        const shaped = (payload && typeof payload === "object") ? payload as { entries?: unknown[]; mtimes?: Record<string, number>; hashes?: Record<string, string> } : null;
        this.store.deserialize(shaped);
        const embedModel = (payload && typeof payload === "object" && "embedModel" in payload && typeof payload.embedModel === "string")
          ? payload.embedModel : undefined;
        await this.saveAll(embedModel);
        if (!this.readOnly) await this.adapter.remove(this.legacyPath());
        return embedModel;
      } catch (e) {
        console.error("Cobrain: 旧 index.json 迁移失败，按空索引处理", e);
      }
    }
    if (opts.legacyDataIndex && typeof opts.legacyDataIndex === "object") {
      try {
        const payload = opts.legacyDataIndex as { entries?: unknown[]; mtimes?: Record<string, number>; hashes?: Record<string, string>; embedModel?: unknown };
        this.store.deserialize(payload);
        const embedModel = typeof payload.embedModel === "string" ? payload.embedModel : undefined;
        if (!this.readOnly) {
          await this.saveAll(embedModel);
          await opts.onMigratedLegacyDataIndex?.();
        }
        return embedModel;
      } catch (e) {
        console.error("Cobrain: data.json.index 迁移失败，按空索引处理", e);
      }
    }
    return undefined;
  }

  async saveFile(path: string): Promise<void> {
    if (this.readOnly) return;
    const sf = this.store.serializeFile(path);
    if (!sf) { await this.removeFile(path); return; }
    await this.ensureDir(this.dir());
    await this.adapter.write(this.shardPath(path), JSON.stringify(sf));
  }

  async removeFile(path: string): Promise<void> {
    if (this.readOnly) return;
    const p = this.shardPath(path);
    if (await this.adapter.exists(p)) await this.adapter.remove(p);
  }

  async saveMeta(embedModel: string): Promise<void> {
    if (this.readOnly) return;
    await this.ensureDir(this.dir());
    await this.adapter.write(this.metaPath(), JSON.stringify({ v: SHARD_V, embedModel }));
  }

  // 全量写出所有分片 + meta + 清孤儿(迁移用)。
  async saveAll(embedModel?: string): Promise<void> {
    if (this.readOnly) return;
    await this.ensureDir(this.dir());
    const wanted = new Set<string>([META]);
    for (const path of this.store.allPaths()) {
      const sf = this.store.serializeFile(path);
      if (!sf) continue;
      const name = this.shardName(path);
      wanted.add(name);
      await this.adapter.write(normalizePath(`${this.dir()}/${name}`), JSON.stringify(sf));
    }
    await this.adapter.write(this.metaPath(), JSON.stringify({ v: SHARD_V, embedModel: embedModel ?? "" }));
    await this.sweep(wanted);
  }

  // 重建结束：写 meta + 清掉当前笔记集合之外的孤儿分片(改名/旧残留)。
  async finalize(embedModel: string): Promise<void> {
    if (Platform.isMobile) return;
    const wanted = new Set<string>([META]);
    for (const path of this.store.allPaths()) wanted.add(this.shardName(path));
    await this.saveMeta(embedModel);
    await this.sweep(wanted);
  }

  private async sweep(wanted: Set<string>): Promise<void> {
    if (!(await this.adapter.exists(this.dir()))) return;
    const listed = await this.adapter.list(this.dir());
    for (const f of listed.files) {
      const name = f.split("/").pop() ?? "";
      if (name.endsWith(".json") && !wanted.has(name)) await this.adapter.remove(f);
    }
  }

  // 换嵌入模型/清空：删掉整个 index/(store 已在外层 deserialize(null))。
  async clearAll(): Promise<void> {
    if (this.readOnly) return;
    if (await this.adapter.exists(this.dir())) await this.adapter.rmdir(this.dir(), true);
  }

  private async ensureDir(dir: string): Promise<void> {
    const parts = normalizePath(dir).split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!(await this.adapter.exists(cur))) await this.adapter.mkdir(cur);
    }
  }
}
