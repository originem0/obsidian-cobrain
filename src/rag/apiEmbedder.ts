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

// 检测某 OpenAI 兼容端点上「实际可用」的嵌入模型：
// 1) 拉 /models 列表；2) 按名字筛出疑似嵌入模型（排除 reranker/聊天）；
// 3) 逐个真实调用 /embeddings 测试，只保留 HTTP 200 且真返回向量的，附带维度。
export async function detectEmbeddingModels(
  baseUrl: string,
  apiKey: string,
): Promise<{ id: string; dim: number }[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const listRes = await requestUrl({
    url: `${base}/models`,
    headers: { Authorization: `Bearer ${apiKey}` },
    throw: false,
  });
  if (listRes.status !== 200) {
    throw new Error(`拉取 /models 失败：HTTP ${listRes.status}`);
  }
  const ids: string[] = (listRes.json?.data ?? []).map((m: any) => m?.id).filter(Boolean);
  const candidates = ids.filter(
    id =>
      /embed|bge|gte|m3e|jina|nomic|nv-?embed|text-embedding|(^|[^a-z0-9])e5([^a-z0-9]|$)/i.test(id) &&
      !/rerank/i.test(id),
  );

  const working: { id: string; dim: number }[] = [];
  const B = 6; // 小批并发，既快又不至于猛冲代理
  for (let i = 0; i < candidates.length; i += B) {
    const batch = candidates.slice(i, i + B);
    const results = await Promise.all(
      batch.map(async id => {
        try {
          const r = await requestUrl({
            url: `${base}/embeddings`,
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model: id, input: "测试" }),
            throw: false,
          });
          const dim = r.status === 200 ? r.json?.data?.[0]?.embedding?.length ?? 0 : 0;
          return dim > 0 ? { id, dim } : null;
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) if (r) working.push(r);
  }
  return working;
}
