import { Tutor } from "./tutor";
import type { CobrainSettings } from "../settings";

function settings(overrides: Partial<CobrainSettings> = {}): CobrainSettings {
  return {
    llmBaseUrl: "https://chat.example/v1",
    llmKey: "k",
    llmModel: "m",
    imageBaseUrl: "",
    imageKey: "",
    imageModel: "",
    imageStyle: "",
    imageQuality: "",
    imageSize: "",
    embedBaseUrl: "",
    embedKey: "",
    embedModel: "",
    noteFolder: "notes",
    attachmentFolder: "assets",
    indexExcludeFolders: "",
    retrievalMinScore: 0.2,
    noteTags: "",
    appendConversation: false,
    conceptMapDirection: "TD",
    conceptMapDetail: "中",
    tutorPrompt: "导师",
    conceptMapPrompt: "概念图",
    notePrompt: "笔记",
    ...overrides,
  };
}

test("ask 在嵌入 API 未配置时跳过检索，仍然能普通对话", async () => {
  const retriever = { retrieve: jest.fn(async () => { throw new Error("不应该检索"); }) };
  const chat = { chat: jest.fn(async () => "回答") };
  const tutor = new Tutor(retriever as any, chat as any, settings());

  const out = await tutor.ask([], "问题");

  expect(retriever.retrieve).not.toHaveBeenCalled();
  expect(chat.chat).toHaveBeenCalled();
  expect(out).toEqual({ reply: "回答", sources: [], related: [] });
});

test("ask 在嵌入 API 配好时会检索并返回来源", async () => {
  const retriever = {
    retrieve: jest.fn(async () => [
      { path: "a.md", heading: "H", text: "片段", score: 0.9 },
    ]),
  };
  const chat = { chat: jest.fn(async () => "回答") };
  const tutor = new Tutor(retriever as any, chat as any, settings({
    embedBaseUrl: "https://embed.example/v1",
    embedKey: "k",
    embedModel: "e",
  }));

  const out = await tutor.ask([], "问题");

  expect(retriever.retrieve).toHaveBeenCalledWith("问题", 8);
  expect(out.sources).toEqual(["a.md"]);
  expect(out.related).toHaveLength(1);
});
