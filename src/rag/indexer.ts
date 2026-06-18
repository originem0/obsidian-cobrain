import { App, TFile, Notice } from "obsidian";
import type { Embedder } from "./embedder";
import { VectorStore } from "./vectorStore";
import { chunkMarkdown } from "./chunker";

export class Indexer {
  constructor(
    private app: App,
    private embedder: Embedder,
    private store: VectorStore
  ) {}

  private async indexFile(file: TFile): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    const chunks = chunkMarkdown(content);
    if (chunks.length === 0) { this.store.removeFile(file.path); return; }
    const vectors = await this.embedder.embedDocuments(chunks.map(c => c.text));
    this.store.setFile(
      file.path,
      file.stat.mtime,
      chunks.map((c, i) => ({ text: c.text, heading: c.heading, vector: vectors[i] }))
    );
  }

  // 全量：跳过 mtime 未变的文件；清理已删除文件
  async reindexAll(onSave: () => Promise<void>): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const present = new Set(files.map(f => f.path));
    for (const p of this.store.allPaths()) {
      if (!present.has(p)) this.store.removeFile(p);
    }
    let done = 0;
    const notice = new Notice("索引中… 0/" + files.length, 0);
    for (const f of files) {
      if (this.store.getMtime(f.path) !== f.stat.mtime) {
        await this.indexFile(f);
      }
      done++;
      notice.setMessage(`索引中… ${done}/${files.length}`);
      if (done % 30 === 0 || done === files.length) {
        await onSave(); // 周期性持久化，防中断丢进度（降低频率以减少整表写入开销）
      }
    }
    notice.hide();
    new Notice(`索引完成：${files.length} 篇`);
  }

  // 增量：单文件变更/删除
  async onModify(file: TFile): Promise<void> { await this.indexFile(file); }
  onDelete(path: string): void { this.store.removeFile(path); }
}
