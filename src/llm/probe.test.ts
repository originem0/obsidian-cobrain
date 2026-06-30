jest.mock("obsidian", () => ({
  requestUrl: jest.fn(),
}), { virtual: true });

import { requestUrl } from "obsidian";
import { classifyModels, ensureCurrentOption } from "./modelClassifier";
import { testChat } from "./probe";

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
  expect(out.image).toEqual(["gpt-image-1", "dall-e-3", "black-forest-labs/flux-kontext"]);
  expect(out.embed).toEqual(["BAAI/bge-m3", "text-embedding-3-small", "intfloat/e5-large-v2"]);
});

test("classifyModels 不把 whisper、tts、rerank 当聊天模型", () => {
  const out = classifyModels(["whisper-1", "tts-1", "bge-reranker-v2-m3", "omni-moderation-latest"]);
  expect(out.chat).toEqual([]);
  expect(out.image).toEqual([]);
  expect(out.embed).toEqual([]);
});

test("classifyModels 空输入返回空分组", () => {
  expect(classifyModels([])).toEqual({ chat: [], image: [], embed: [] });
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
