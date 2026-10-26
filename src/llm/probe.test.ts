jest.mock("obsidian", () => ({
  requestUrl: jest.fn(),
}), { virtual: true });

import { requestUrl } from "obsidian";
import { classifyModels, ensureCurrentOption } from "./modelClassifier";
import { detectEmbeddingModels, listModels, testChat } from "./probe";

// withTimeout 用 window.setTimeout；node 测试环境无 window，指到 globalThis 上。
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
const mockRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;

test("classifyModels 按用途粗分模型", () => {
  const out = classifyModels([
    "z-ai/glm-5.1",
    "gpt-4o-mini",
    "gpt-image-1",
    "dall-e-3",
    "black-forest-labs/flux-kontext",
    "BAAI/bge-m3",
    "text-embedding-3-small",
    "intfloat/e5-large-v2",
    "whisper-1",
    "tts-1",
    "bge-reranker-v2-m3",
  ]);

  expect(out.chat).toEqual(["z-ai/glm-5.1", "gpt-4o-mini"]);
  expect(out.embed).toEqual(["BAAI/bge-m3", "text-embedding-3-small", "intfloat/e5-large-v2"]);
});

test("classifyModels 不把 whisper、tts、rerank 当聊天模型", () => {
  const out = classifyModels(["whisper-1", "tts-1", "bge-reranker-v2-m3", "omni-moderation-latest"]);
  expect(out.chat).toEqual([]);
  expect(out.embed).toEqual([]);
});

test("classifyModels 空输入返回空分组", () => {
  expect(classifyModels([])).toEqual({ chat: [], embed: [] });
});

test("ensureCurrentOption 把当前值并入候选(不在则置顶,在则原样,空值不塞)", () => {
  expect(ensureCurrentOption(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  expect(ensureCurrentOption(["a", "b"], "a")).toEqual(["a", "b"]);
  expect(ensureCurrentOption(["a", "b"], "")).toEqual(["a", "b"]);
  expect(ensureCurrentOption([], "x")).toEqual(["x"]);
});

test("testChat：HTTP 200 但 content 为空判为不可用（推理模型 max_tokens:1 误报防护）", async () => {
  mockRequestUrl.mockResolvedValue({ status: 200, json: { choices: [{ message: { content: "" } }] } } as never);
  const r = await testChat("https://x/v1", "k", "m");
  expect(r.ok).toBe(false);
});

test("testChat：HTTP 200 且有内容判为可用", async () => {
  mockRequestUrl.mockResolvedValue({ status: 200, json: { choices: [{ message: { content: "ok" } }] } } as never);
  const r = await testChat("https://x/v1", "k", "m");
  expect(r.ok).toBe(true);
});

test("testChat：非 200 判为不可用", async () => {
  mockRequestUrl.mockResolvedValue({ status: 401, json: {}, text: "unauthorized" } as never);
  const r = await testChat("https://x/v1", "k", "m");
  expect(r.ok).toBe(false);
});

test("listModels 只保留非空字符串 id；返回体没有模型数组时报错", async () => {
  mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { data: [{ id: "a" }, { id: "" }, { id: 3 }, { name: "x" }, null, "b"] } } as never);
  await expect(listModels("https://x/v1", "k")).resolves.toEqual(["a"]);
  mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { models: [{ id: "a" }] } } as never);
  await expect(listModels("https://x/v1", "k")).rejects.toThrow("没有模型数组");
});

test("detectEmbeddingModels 只保留真实返回向量的嵌入模型并附带维度", async () => {
  mockRequestUrl.mockImplementation((async (req: { url: string; body?: string }) => {
    if (req.url.endsWith("/models")) return { status: 200, json: { data: [{ id: "text-embedding-3-small" }, { id: "bge-m3" }, { id: "gpt-4o" }] } };
    const model = (JSON.parse(req.body ?? "{}") as { model?: string }).model;
    return model === "text-embedding-3-small"
      ? { status: 200, json: { data: [{ embedding: [0.1, 0.2, 0.3] }] } }
      : { status: 200, json: { data: [{}] } };
  }) as never);
  await expect(detectEmbeddingModels("https://x/v1", "k")).resolves.toEqual([{ id: "text-embedding-3-small", dim: 3 }]);
  mockRequestUrl.mockReset();
});
