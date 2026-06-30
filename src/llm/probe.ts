import { requestUrl } from "obsidian";
import { withTimeout } from "../util/withTimeout";
import { classifyModels } from "./modelClassifier";
import { parseChatResponse } from "./chatClient";
export { classifyModels } from "./modelClassifier";

const PROBE_TIMEOUT_MS = 30_000;
const CHAT_TEST_TIMEOUT_MS = 90_000;

export async function listModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const res = await withTimeout(
    requestUrl({
      url: `${base}/models`,
      headers: { Authorization: `Bearer ${apiKey}` },
      throw: false,
    }),
    PROBE_TIMEOUT_MS,
    "拉取模型列表",
  );
  if (res.status !== 200) {
    throw new Error(`拉取 /models 失败：HTTP ${res.status} ${(res.text || "").slice(0, 200)}`);
  }
  const json: unknown = res.json;
  const data = json && typeof json === "object" && "data" in json ? json.data : undefined;
  if (!Array.isArray(data)) {
    throw new Error("拉取 /models 失败：返回体里没有模型数组");
  }
  return data
    .map(m => (m && typeof m === "object" && "id" in m ? m.id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

export async function testChat(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<{ ok: boolean; ms: number; error?: string }> {
  const base = baseUrl.replace(/\/+$/, "");
  const started = Date.now();
  // 把超时/网络异常也收进返回值,兑现「不抛错」的签名契约(调用方据 ok 点灯即可)
  try {
    const res = await withTimeout(
      requestUrl({
        url: `${base}/chat/completions`,
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        }),
        throw: false,
      }),
      CHAT_TEST_TIMEOUT_MS,
      "聊天测试",
    );
    const ms = Date.now() - started;
    if (res.status === 200) {
      // 不只看 200：推理模型在 max_tokens:1 下会 200 但 content 为空，借 parseChatResponse 验真有内容
      try {
        parseChatResponse(res.json);
        return { ok: true, ms };
      } catch (e) {
        return { ok: false, ms, error: e instanceof Error ? e.message : String(e) };
      }
    }
    return { ok: false, ms, error: `HTTP ${res.status} ${(res.text || "").slice(0, 200)}` };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
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
  const candidates = classifyModels(await listModels(baseUrl, apiKey)).embed;

  const working: { id: string; dim: number }[] = [];
  const B = 6; // 小批并发，既快又不至于猛冲代理
  for (let i = 0; i < candidates.length; i += B) {
    const batch = candidates.slice(i, i + B);
    const results = await Promise.all(
      batch.map(async id => {
        try {
          const r = await withTimeout(
            requestUrl({
              url: `${base}/embeddings`,
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
              body: JSON.stringify({ model: id, input: "测试" }),
              throw: false,
            }),
            PROBE_TIMEOUT_MS,
            "探测嵌入模型",
          );
          let dim = 0;
          if (r.status === 200) {
            const json: unknown = r.json;
            const emb = json && typeof json === "object" && "data" in json && Array.isArray(json.data)
              && json.data[0] && typeof json.data[0] === "object" && "embedding" in json.data[0]
              && Array.isArray(json.data[0].embedding) ? json.data[0].embedding : undefined;
            dim = emb?.length ?? 0;
          }
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
