import { requestUrl } from "obsidian";
import type { Embedder } from "./embedder";

// L2 归一化：向量库用点积当 cosine（topK 约定向量已归一化），故这里统一归一化。
function normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map(x => x / n);
}

// OpenAI 兼容的云端 embeddings。用 Obsidian requestUrl（免 CORS）异步调用，
// 不占用主线程 → 索引时不卡 UI；比本地 wasm 快且质量更好。
export class ApiEmbedder implements Embedder {
  dim: number | null = null;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
  ) {}

  private async embed(inputs: string[]): Promise<number[][]> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/embeddings`;
    const res = await requestUrl({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: inputs }),
      throw: false,
    });
    if (res.status !== 200) {
      throw new Error(`embeddings API ${res.status}: ${(res.text || "").slice(0, 200)}`);
    }
    const data = (res.json.data as { embedding: number[]; index: number }[])
      .slice()
      .sort((a, b) => a.index - b.index);
    const vecs = data.map(d => normalize(d.embedding));
    if (vecs[0]) this.dim = vecs[0].length;
    return vecs;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    const B = 64; // OpenAI embeddings 接口支持批量 input
    for (let i = 0; i < texts.length; i += B) {
      out.push(...(await this.embed(texts.slice(i, i + B))));
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    return (await this.embed([text]))[0];
  }
}
