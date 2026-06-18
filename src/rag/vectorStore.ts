import { topK } from "./vectorMath";

export interface Entry { path: string; chunkIdx: number; text: string; heading: string; vector: number[]; }
export interface QueryHit { path: string; text: string; heading: string; score: number; }
interface ChunkInput { text: string; heading: string; vector: number[]; }

export class VectorStore {
  private entries: Entry[] = [];
  private mtimes: Record<string, number> = {};
  // 每文件内容哈希：用于跳过「内容没变」的重嵌（见 Indexer.indexFile）
  private hashes: Record<string, string> = {};

  setFile(path: string, mtime: number, chunks: ChunkInput[]): void {
    this.removeFile(path);
    chunks.forEach((c, i) =>
      this.entries.push({ path, chunkIdx: i, text: c.text, heading: c.heading, vector: c.vector })
    );
    this.mtimes[path] = mtime;
  }

  removeFile(path: string): void {
    this.entries = this.entries.filter(e => e.path !== path);
    delete this.mtimes[path];
    delete this.hashes[path];
  }

  getMtime(path: string): number | null {
    return path in this.mtimes ? this.mtimes[path] : null;
  }

  setMtime(path: string, mtime: number): void {
    this.mtimes[path] = mtime;
  }

  getHash(path: string): string | null {
    return path in this.hashes ? this.hashes[path] : null;
  }

  setHash(path: string, hash: string): void {
    this.hashes[path] = hash;
  }

  query(vector: number[], k: number): QueryHit[] {
    // 维度守卫：查询向量与索引向量维度不一致 → 换过模型但没重建索引。
    // 不拦截的话点积会算出垃圾且不报错（曾踩过这个坑）。
    if (this.entries.length && this.entries[0].vector.length !== vector.length) {
      throw new Error(
        `嵌入维度不一致：查询 ${vector.length} 维，索引 ${this.entries[0].vector.length} 维。请运行「Cobrain: 重建索引」`,
      );
    }
    const scored = topK(
      vector,
      this.entries.map(e => ({ id: `${e.path}#${e.chunkIdx}`, vector: e.vector })),
      k
    );
    return scored.map(s => {
      const e = this.entries.find(x => `${x.path}#${x.chunkIdx}` === s.id)!;
      return { path: e.path, text: e.text, heading: e.heading, score: s.score };
    });
  }

  serialize(): { entries: Entry[]; mtimes: Record<string, number>; hashes: Record<string, string> } {
    return { entries: this.entries, mtimes: this.mtimes, hashes: this.hashes };
  }

  deserialize(
    data: { entries: Entry[]; mtimes: Record<string, number>; hashes?: Record<string, string> } | null,
  ): void {
    this.entries = data?.entries ?? [];
    this.mtimes = data?.mtimes ?? {};
    this.hashes = data?.hashes ?? {};
  }

  allPaths(): string[] { return Object.keys(this.mtimes); }
}
