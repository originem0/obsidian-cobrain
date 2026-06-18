import { topK } from "./vectorMath";

export interface Entry { path: string; chunkIdx: number; text: string; heading: string; vector: number[]; }
export interface QueryHit { path: string; text: string; heading: string; score: number; }
interface ChunkInput { text: string; heading: string; vector: number[]; }

export class VectorStore {
  private entries: Entry[] = [];
  private mtimes: Record<string, number> = {};

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
  }

  getMtime(path: string): number | null {
    return path in this.mtimes ? this.mtimes[path] : null;
  }

  query(vector: number[], k: number): QueryHit[] {
    // 维度守卫：查询向量与索引向量维度不一致 → 换过模型但没重建索引。
    // 不拦截的话点积会算出垃圾且不报错（曾踩过这个坑）。
    if (this.entries.length && this.entries[0].vector.length !== vector.length) {
      throw new Error(
        `嵌入维度不一致：查询 ${vector.length} 维，索引 ${this.entries[0].vector.length} 维。请运行「LT: 重建索引」`,
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

  serialize(): { entries: Entry[]; mtimes: Record<string, number> } {
    return { entries: this.entries, mtimes: this.mtimes };
  }

  deserialize(data: { entries: Entry[]; mtimes: Record<string, number> } | null): void {
    this.entries = data?.entries ?? [];
    this.mtimes = data?.mtimes ?? {};
  }

  allPaths(): string[] { return Object.keys(this.mtimes); }
}
