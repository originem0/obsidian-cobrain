import { classifyModels } from "./modelClassifier";

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
