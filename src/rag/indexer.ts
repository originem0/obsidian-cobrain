import { App, TFile, Notice } from "obsidian";
import type { Embedder } from "./embedder";
import { VectorStore } from "./vectorStore";
import { chunkMarkdown } from "./chunker";
import { fnv1a } from "../util/hash";
import { IndexStore } from "./indexStore";
import type { CobrainSettings } from "../settings";

export type IndexFileResult = "saved" | "removed" | "unchanged";
export interface IndexFailure { path: string; message: string; at: number; }
export interface IndexStatus {
  running: boolean;
  lastChangedAt: number | null;
  lastFullReindexAt: number | null;
  failures: IndexFailure[];
}

function excludedFolders(raw: string): string[] {
  return raw
    .split(/[\n,，]/)
    .map(s => s.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
}

export function shouldIndexPath(path: string, settings: Pick<CobrainSettings, "indexExcludeFolders">): boolean {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.slice(0, -1).some(part => part.startsWith("."))) return false;
  const excludes = excludedFolders(settings.indexExcludeFolders);
  return !excludes.some(folder => normalized === folder || normalized.startsWith(folder + "/"));
}

export class Indexer {
  private running = false; // 防「重建索引」重入：两个全量重建并发会互踩 store 与分片写
  private lastChangedAt: number | null = null;
  private lastFullReindexAt: number | null = null;
  private failures: IndexFailure[] = [];
  constructor(
    private app: App,
    private embedder: Embedder,
    private store: VectorStore,
    private settings: Pick<CobrainSettings, "indexExcludeFolders">,
  ) {}

  private async indexFile(file: TFile, persist: IndexStore, force: boolean): Promise<IndexFileResult> {
    if (!shouldIndexPath(file.path, this.settings)) {
      this.store.removeFile(file.path);
      await persist.removeFile(file.path);
      this.markChanged(file.path);
      return "removed";
    }
    const content = await this.app.vault.cachedRead(file);
    const hash = fnv1a(content);
    // 内容哈希未变（即便 mtime 变了）：跳过重嵌，仅同步 mtime，省下嵌入 API 调用。
    // 覆盖「保存但无实质改动 / 重复重建 / 外部 touch」。块级增量 diff 留待后续，文件级是 80/20。
    if (!force && this.store.getHash(file.path) === hash) {
      if (this.store.getMtime(file.path) !== file.stat.mtime) {
        this.store.setMtime(file.path, file.stat.mtime);
        await persist.saveFile(file.path);
        this.markChanged(file.path);
        return "saved";
      }
      return "unchanged";
    }
    const chunks = chunkMarkdown(content);
    if (chunks.length === 0) {
      this.store.removeFile(file.path);
      await persist.removeFile(file.path);
      this.markChanged(file.path);
      return "removed";
    }
    // 内容已变，旧向量不能继续冒充新文件。先移除旧分片；嵌入失败时宁可无索引。
    this.store.removeFile(file.path);
    await persist.removeFile(file.path);
    const vectors = await this.embedder.embedDocuments(chunks.map(c => c.text));
    if (vectors.length !== chunks.length) {
      throw new Error(`嵌入返回数量不匹配：请求 ${chunks.length}，返回 ${vectors.length}`);
    }
    this.store.setFile(
      file.path,
      file.stat.mtime,
      chunks.map((c, i) => ({ text: c.text, heading: c.heading, vector: vectors[i] }))
    );
    this.store.setHash(file.path, hash);
    await persist.saveFile(file.path);
    this.markChanged(file.path);
    return "saved";
  }

  private markChanged(path: string): void {
    this.lastChangedAt = Date.now();
    this.failures = this.failures.filter(f => f.path !== path);
  }

  recordChange(path: string): void {
    this.markChanged(path);
  }

  recordFailure(path: string, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.failures = [{ path, message, at: Date.now() }, ...this.failures.filter(f => f.path !== path)].slice(0, 20);
  }

  getStatus(): IndexStatus {
    return {
      running: this.running,
      lastChangedAt: this.lastChangedAt,
      lastFullReindexAt: this.lastFullReindexAt,
      failures: [...this.failures],
    };
  }

  // 全量：跳过 mtime 未变的文件；删除已不存在文件的分片；每篇即时落分片(崩溃不丢进度)，结束写 meta + 清孤儿。
  async reindexAll(persist: IndexStore, embedModel: string, opts: { force?: boolean } = {}): Promise<void> {
    if (this.running) { new Notice("索引正在进行中，请稍候…"); return; }
    this.running = true;
    const files = this.app.vault.getMarkdownFiles().filter(f => shouldIndexPath(f.path, this.settings));
    const present = new Set(files.map(f => f.path));
    for (const p of this.store.allPaths()) {
      if (!present.has(p)) { this.store.removeFile(p); await persist.removeFile(p); }
    }
    let done = 0;
    let failed = 0;
    const notice = new Notice("索引中… 0/" + files.length, 0);
    try {
      for (const f of files) {
        if (opts.force || this.store.getMtime(f.path) !== f.stat.mtime) {
          try {
            await this.indexFile(f, persist, opts.force === true);
          } catch (e) {
            // 单篇失败(如嵌入 API 抖动)不中断整轮；记数继续，结束时汇报
            failed++;
            this.recordFailure(f.path, e);
            this.store.removeFile(f.path);
            await persist.removeFile(f.path);
            console.error(`索引失败：${f.path}`, e);
          }
        }
        done++;
        notice.setMessage(`索引中… ${done}/${files.length}`);
      }
      await persist.finalize(embedModel);
      this.lastFullReindexAt = Date.now();
      new Notice(
        failed ? `索引完成：${files.length} 篇，${failed} 篇失败（见控制台）` : `索引完成：${files.length} 篇`,
      );
    } finally {
      notice.hide();
      this.running = false;
    }
  }

  // 增量：单文件变更/删除。onModify 透传 changed，供调用方决定是否落分片。
  async onModify(file: TFile, persist: IndexStore): Promise<IndexFileResult> {
    return this.indexFile(file, persist, false);
  }
  onDelete(path: string): void {
    this.store.removeFile(path);
    this.markChanged(path);
  }
}
