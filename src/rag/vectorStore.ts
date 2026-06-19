import { topK } from "./vectorMath";
import { quantizeVector, dequantizeVector } from "../util/quantize";

export interface Entry { path: string; chunkIdx: number; text: string; heading: string; vector: number[]; }
export interface QueryHit { path: string; text: string; heading: string; score: number; }
interface ChunkInput { text: string; heading: string; vector: number[]; }
// 磁盘存储格式：向量量化为 int8(base64)，体积约为 float64 JSON 的 1/15
interface StoredEntry { path: string; chunkIdx: number; text: string; heading: string; scale: number; q: string; }

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

  // 改名/移动：把某篇的条目/mtime/hash 整体改键到新路径（内容没变，不重嵌）。
  renameFile(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    for (const e of this.entries) if (e.path === oldPath) e.path = newPath;
    if (oldPath in this.mtimes) { this.mtimes[newPath] = this.mtimes[oldPath]; delete this.mtimes[oldPath]; }
    if (oldPath in this.hashes) { this.hashes[newPath] = this.hashes[oldPath]; delete this.hashes[oldPath]; }
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

  serialize(): { v: number; entries: StoredEntry[]; mtimes: Record<string, number>; hashes: Record<string, string> } {
    const entries = this.entries.map((e): StoredEntry => {
      const { scale, q } = quantizeVector(e.vector);
      return { path: e.path, chunkIdx: e.chunkIdx, text: e.text, heading: e.heading, scale, q };
    });
    return { v: 2, entries, mtimes: this.mtimes, hashes: this.hashes };
  }

  // 兼容两种 entry：带 q(base64) 是 v2 量化格式，反量化回 float；带 vector(数组) 是旧 float64，直接用。
  deserialize(
    data: { entries?: unknown[]; mtimes?: Record<string, number>; hashes?: Record<string, string> } | null,
  ): void {
    const raw = (data?.entries ?? []) as Array<Record<string, unknown>>;
    this.entries = raw.map((e): Entry => ({
      path: e.path as string,
      chunkIdx: e.chunkIdx as number,
      text: e.text as string,
      heading: e.heading as string,
      vector:
        typeof e.q === "string"
          ? dequantizeVector(e.scale as number, e.q)
          : ((e.vector as number[]) ?? []),
    }));
    this.mtimes = data?.mtimes ?? {};
    this.hashes = data?.hashes ?? {};
  }

  // 单篇分片序列化：entries 省去 path(在顶层)以减小体积；该篇无条目返回 null。
  serializeFile(path: string): { path: string; mtime: number; hash: string; entries: Omit<StoredEntry, "path">[] } | null {
    const es = this.entries.filter(e => e.path === path);
    if (!es.length) return null;
    const entries = es.map(e => {
      const { scale, q } = quantizeVector(e.vector);
      return { chunkIdx: e.chunkIdx, text: e.text, heading: e.heading, scale, q };
    });
    return { path, mtime: this.mtimes[path] ?? 0, hash: this.hashes[path] ?? "", entries };
  }

  // 把单篇分片合并进 store(追加条目 + 设 mtime/hash)。兼容 q(量化) 与 vector(旧)。
  deserializeFile(payload: { path: string; mtime?: number; hash?: string; entries?: unknown[] }): void {
    const path = payload.path;
    const raw = (payload.entries ?? []) as Array<Record<string, unknown>>;
    for (const e of raw) {
      this.entries.push({
        path,
        chunkIdx: e.chunkIdx as number,
        text: e.text as string,
        heading: e.heading as string,
        vector: typeof e.q === "string" ? dequantizeVector(e.scale as number, e.q) : ((e.vector as number[]) ?? []),
      });
    }
    if (payload.mtime != null) this.mtimes[path] = payload.mtime;
    if (payload.hash != null) this.hashes[path] = payload.hash;
  }

  allPaths(): string[] { return Object.keys(this.mtimes); }
}
