import { quantizeToBytes, dotQuantized, int8ToBase64, int8FromBase64 } from "../util/quantize";

export interface Entry { path: string; chunkIdx: number; text: string; heading: string; q: Int8Array; scale: number; }
export interface QueryHit { path: string; text: string; heading: string; score: number; }
interface ChunkInput { text: string; heading: string; vector: number[]; }
// 磁盘存储格式：向量量化为 int8(base64)，体积约为 float64 JSON 的 1/15
interface StoredEntry { path: string; chunkIdx: number; text: string; heading: string; scale: number; q: string; }

// 大库检索分批让出主线程：超过阈值后每批 await 一次，避免一次性同步点积卡死 UI。
const QUERY_YIELD_THRESHOLD = 8000;
const QUERY_BATCH = 2000;
function yieldToMain(): Promise<void> {
  return new Promise(r => window.setTimeout(r, 0));
}

// 反序列化单条 entry 到内存量化表示：q(base64)→Int8Array；旧 vector(float 数组)→量化转入。
function toMemoryVector(e: Record<string, unknown>): { q: Int8Array; scale: number } {
  if (typeof e.q === "string") {
    return { q: int8FromBase64(e.q), scale: (e.scale as number) ?? 0 };
  }
  const r = quantizeToBytes((e.vector as number[]) ?? []);
  return { q: r.bytes, scale: r.scale };
}

export class VectorStore {
  // 运行时索引：向量以 int8(Int8Array)+scale 常驻，而非 float64，内存约降 8 倍。
  private entries: Entry[] = [];
  private mtimes: Record<string, number> = {};
  // 每文件内容哈希：用于跳过「内容没变」的重嵌（见 Indexer.indexFile）
  private hashes: Record<string, string> = {};

  setFile(path: string, mtime: number, chunks: ChunkInput[]): void {
    this.removeFile(path);
    chunks.forEach((c, i) => {
      const { scale, bytes } = quantizeToBytes(c.vector);
      this.entries.push({ path, chunkIdx: i, text: c.text, heading: c.heading, q: bytes, scale });
    });
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

  async query(vector: number[], k: number, minScore = -Infinity): Promise<QueryHit[]> {
    // 快照 entries：大库分批 await 期间若有增删重置 this.entries，本次仍迭代稳定的旧数组，不崩（结果至多略陈旧）。
    const entries = this.entries;
    // 维度守卫：查询向量与索引向量维度不一致 → 换过模型但没重建索引。
    // 不拦截的话点积会算出垃圾且不报错（曾踩过这个坑）。
    if (entries.length && entries[0].q.length !== vector.length) {
      throw new Error(
        `嵌入维度不一致：查询 ${vector.length} 维，索引 ${entries[0].q.length} 维。请运行「Cobrain: 重建索引」`,
      );
    }
    // int8 点积打分：dotQuantized 与「先反量化再点积」等价，故 minScore 仍可直接比较。
    const big = entries.length > QUERY_YIELD_THRESHOLD;
    const scored: { e: Entry; score: number }[] = new Array(entries.length);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      scored[i] = { e, score: dotQuantized(vector, e.q, e.scale) };
      if (big && i > 0 && i % QUERY_BATCH === 0) await yieldToMain();
    }
    scored.sort((a, b) => b.score - a.score);
    // 按「笔记」去重返回 top-k：每篇只保留分数最高的那个 chunk。
    // 旧实现取 top-k chunk，同一篇笔记的多个 chunk 会挤占名额，把别的相关笔记挤出榜；
    // 中文长文的相似度分布又往往很平，于是稍逊但不同主题的好笔记容易被切掉。按篇去重让名额分散到更多笔记上。
    const hits: QueryHit[] = [];
    const seen = new Set<string>();
    for (const { e, score } of scored) {
      if (seen.has(e.path)) continue;
      seen.add(e.path);
      if (score < minScore) continue;
      hits.push({ path: e.path, text: e.text, heading: e.heading, score });
      if (hits.length >= k) break;
    }
    return hits;
  }

  serialize(): { v: number; entries: StoredEntry[]; mtimes: Record<string, number>; hashes: Record<string, string> } {
    const entries = this.entries.map((e): StoredEntry => ({
      path: e.path, chunkIdx: e.chunkIdx, text: e.text, heading: e.heading, scale: e.scale, q: int8ToBase64(e.q),
    }));
    return { v: 2, entries, mtimes: this.mtimes, hashes: this.hashes };
  }

  // 兼容两种 entry：带 q(base64) 是 v2 量化格式，回到 Int8Array；带 vector(数组) 是旧 float64，量化转入。
  deserialize(
    data: { entries?: unknown[]; mtimes?: Record<string, number>; hashes?: Record<string, string> } | null,
  ): void {
    const raw = (data?.entries ?? []) as Array<Record<string, unknown>>;
    this.entries = raw.map((e): Entry => {
      const { q, scale } = toMemoryVector(e);
      return {
        path: e.path as string,
        chunkIdx: e.chunkIdx as number,
        text: e.text as string,
        heading: e.heading as string,
        q,
        scale,
      };
    });
    this.mtimes = data?.mtimes ?? {};
    this.hashes = data?.hashes ?? {};
  }

  // 单篇分片序列化：entries 省去 path(在顶层)以减小体积；该篇无条目返回 null。
  serializeFile(path: string): { path: string; mtime: number; hash: string; entries: Omit<StoredEntry, "path">[] } | null {
    const es = this.entries.filter(e => e.path === path);
    if (!es.length) return null;
    const entries = es.map(e => ({ chunkIdx: e.chunkIdx, text: e.text, heading: e.heading, scale: e.scale, q: int8ToBase64(e.q) }));
    return { path, mtime: this.mtimes[path] ?? 0, hash: this.hashes[path] ?? "", entries };
  }

  // 把单篇分片合并进 store(追加条目 + 设 mtime/hash)。兼容 q(量化) 与 vector(旧)。
  deserializeFile(payload: { path: string; mtime?: number; hash?: string; entries?: unknown[] }): void {
    const path = payload.path;
    const raw = (payload.entries ?? []) as Array<Record<string, unknown>>;
    for (const e of raw) {
      const { q, scale } = toMemoryVector(e);
      this.entries.push({
        path,
        chunkIdx: e.chunkIdx as number,
        text: e.text as string,
        heading: e.heading as string,
        q,
        scale,
      });
    }
    if (payload.mtime != null) this.mtimes[path] = payload.mtime;
    if (payload.hash != null) this.hashes[path] = payload.hash;
  }

  allPaths(): string[] { return Object.keys(this.mtimes); }
  entryCount(): number { return this.entries.length; }
}
