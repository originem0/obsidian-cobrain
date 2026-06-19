import { App, TFile, Notice } from "obsidian";
import type { Embedder } from "./embedder";
import { VectorStore } from "./vectorStore";
import { chunkMarkdown } from "./chunker";
import { fnv1a } from "../util/hash";
import { IndexStore } from "./indexStore";

export class Indexer {
  private running = false; // 防「重建索引」重入：两个全量重建并发会互踩 store 与分片写
  constructor(
    private app: App,
    private embedder: Embedder,
    private store: VectorStore
  ) {}

  private async indexFile(file: TFile): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    const hash = fnv1a(content);
    // 内容哈希未变（即便 mtime 变了）：跳过重嵌，仅同步 mtime，省下嵌入 API 调用。
    // 覆盖「保存但无实质改动 / 重复重建 / 外部 touch」。块级增量 diff 留待后续，文件级是 80/20。
    if (this.store.getHash(file.path) === hash) {
      this.store.setMtime(file.path, file.stat.mtime);
      return;
    }
    const chunks = chunkMarkdown(content);
    if (chunks.length === 0) { this.store.removeFile(file.path); return; }
    const vectors = await this.embedder.embedDocuments(chunks.map(c => c.text));
    this.store.setFile(
      file.path,
      file.stat.mtime,
      chunks.map((c, i) => ({ text: c.text, heading: c.heading, vector: vectors[i] }))
    );
    this.store.setHash(file.path, hash);
  }

  // 全量：跳过 mtime 未变的文件；删除已不存在文件的分片；每篇即时落分片(崩溃不丢进度)，结束写 meta + 清孤儿。
  async reindexAll(persist: IndexStore, embedModel: string): Promise<void> {
    if (this.running) { new Notice("索引正在进行中，请稍候…"); return; }
    this.running = true;
    const files = this.app.vault.getMarkdownFiles();
    const present = new Set(files.map(f => f.path));
    for (const p of this.store.allPaths()) {
      if (!present.has(p)) { this.store.removeFile(p); await persist.removeFile(p); }
    }
    let done = 0;
    let failed = 0;
    const notice = new Notice("索引中… 0/" + files.length, 0);
    try {
      for (const f of files) {
        if (this.store.getMtime(f.path) !== f.stat.mtime) {
          try {
            await this.indexFile(f);
            await persist.saveFile(f.path);
          } catch (e) {
            // 单篇失败(如嵌入 API 抖动)不中断整轮；记数继续，结束时汇报
            failed++;
            console.error(`索引失败：${f.path}`, e);
          }
        }
        done++;
        notice.setMessage(`索引中… ${done}/${files.length}`);
      }
      await persist.finalize(embedModel);
      new Notice(
        failed ? `索引完成：${files.length} 篇，${failed} 篇失败（见控制台）` : `索引完成：${files.length} 篇`,
      );
    } finally {
      notice.hide();
      this.running = false;
    }
  }

  // 增量：单文件变更/删除
  async onModify(file: TFile): Promise<void> { await this.indexFile(file); }
  onDelete(path: string): void { this.store.removeFile(path); }
}
