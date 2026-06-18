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
