import { pipeline, env } from "@huggingface/transformers";
import type { Embedder } from "./embedder";

// e5 系列要求文档/查询分别加前缀；非 e5 模型设 useE5Prefix=false。
export class LocalEmbedder implements Embedder {
  private extractor: any = null;
  private loading: Promise<void> | null = null;
  dim: number | null = null;

  constructor(
    private modelId = "Xenova/multilingual-e5-small",
    private useE5Prefix = true,
    private wasmPaths?: Record<string, string>,
  ) {
    // 允许从 HF CDN 拉取模型；首次使用时下载并缓存
    env.allowRemoteModels = true;
  }

  private async ensure(): Promise<void> {
    if (this.extractor) return;
    if (!this.loading) {
      this.loading = (async () => {
        // env.backends.onnx === onnxruntime-web 的 env（见 transformers onnx.js: env.backends.onnx = ONNX_ENV）
        const wasm = (env.backends as any)?.onnx?.wasm;
        if (wasm) {
          wasm.numThreads = 1; // 单线程：避免加载需 worker_threads 的多线程 glue
          if (this.wasmPaths) wasm.wasmPaths = this.wasmPaths; // 本地 patched glue + wasm 的 blob URL
        }
        this.extractor = await pipeline("feature-extraction", this.modelId, {
          device: "wasm",
          dtype: "fp32",
        });
      })();
    }
    await this.loading;
  }

  private async embedOne(text: string): Promise<number[]> {
    await this.ensure();
    const res = await this.extractor(text, { pooling: "mean", normalize: true });
    const vec = Array.from(res.data as Float32Array) as number[];
    this.dim = vec.length;
    return vec;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const t of texts) {
      out.push(await this.embedOne(this.useE5Prefix ? `passage: ${t}` : t));
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embedOne(this.useE5Prefix ? `query: ${text}` : text);
  }
}
