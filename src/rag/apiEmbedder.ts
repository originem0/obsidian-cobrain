import { requestUrl } from "obsidian";
import { withTimeout } from "../util/withTimeout";
import type { Embedder } from "./embedder";
import type { CobrainSettings } from "../settings";

// 嵌入超时 60s。requestUrl 不可中止，超时仅解锁 UI。
const EMBED_TIMEOUT_MS = 60_000;

// L2 归一化：向量库用点积当 cosine（topK 约定向量已归一化），故这里统一归一化。
function normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map(x => x / n);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => window.setTimeout(r, ms));
}

// OpenAI 兼容的云端 embeddings。用 Obsidian requestUrl（免 CORS）异步调用，不占用主线程。
// 持有 settings 引用，调用时读最新 baseUrl/key/model（改设置即时生效）。
export class ApiEmbedder implements Embedder {
  constructor(private settings: CobrainSettings) {}

  private async embed(inputs: string[]): Promise<number[][]> {
    const url = `${this.settings.embedBaseUrl.replace(/\/+$/, "")}/embeddings`;
    const maxRetries = 3;
    for (let attempt = 0; ; attempt++) {
      const res = await withTimeout(
        requestUrl({
          url,
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.settings.embedKey}` },
          body: JSON.stringify({ model: this.settings.embedModel, input: inputs }),
          throw: false,
        }),
        EMBED_TIMEOUT_MS,
        "嵌入 API",
      );
      if (res.status === 200) {
        const json: unknown = res.json;
        if (!json || typeof json !== "object" || !("data" in json) || !Array.isArray(json.data)) {
          throw new Error("嵌入 API 返回格式异常：缺少 data 数组");
        }
        const data: Array<{ embedding: number[]; index: number }> = [];
        for (const item of json.data) {
          if (item && typeof item === "object" && "embedding" in item && Array.isArray(item.embedding) && "index" in item && typeof item.index === "number") {
            data.push({ embedding: item.embedding as number[], index: item.index });
          }
        }
        data.sort((a, b) => a.index - b.index);
        const vecs = data.map(d => normalize(d.embedding));
        return vecs;
      }
      // 429（限流）/ 5xx（服务端抖动）退避重试；其它 4xx 是请求本身的问题，重试无意义，直接抛
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        throw new Error(`embeddings API ${res.status}: ${(res.text || "").slice(0, 200)}`);
      }
      await sleep(1000 * 2 ** attempt); // 1s → 2s → 4s
    }
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
