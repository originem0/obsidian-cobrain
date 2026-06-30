import { Tutor } from "./tutor";
import type { CobrainSettings } from "../settings";
import type { ChatMsg } from "../llm/chatClient";

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

test("conceptMap 用最近一条用户发言检索，并把整段对话作为材料", async () => {
  const retriever = { retrieve: jest.fn(async () => []) };
  const chat = { chat: jest.fn(async (_msgs: ChatMsg[]) => "```mermaid\ngraph TD\n```") };
  const tutor = new Tutor(retriever as any, chat as any, settings({
    embedBaseUrl: "https://e", embedKey: "k", embedModel: "e",
  }));

  await tutor.conceptMap([
    { role: "user", content: "第一个问题" },
    { role: "assistant", content: "回应" },
    { role: "user", content: "最后的问题" },
  ]);

  // 检索用最近一条用户发言（而非整段长文）
  expect(retriever.retrieve).toHaveBeenCalledWith("最后的问题", 8);
  // 但整段对话都进入了发给模型的 user 消息
  const sentUser = chat.chat.mock.calls[0][0].find(m => m.role === "user")!.content;
  expect(sentUser).toContain("第一个问题");
  expect(sentUser).toContain("最后的问题");
});

test("critique / summarizeNote 只发最近 40 条历史", async () => {
  const chat = { chat: jest.fn(async (_msgs: ChatMsg[]) => "标题：T\n正文") };
  const tutor = new Tutor({ retrieve: jest.fn() } as any, chat as any, settings());
  const history = Array.from({ length: 50 }, (_, i): ChatMsg => ({ role: "user", content: `m${i}` }));

  await tutor.critique(history);
  let sent = chat.chat.mock.calls[0][0].find(m => m.role === "user")!.content;
  expect(sent).toContain("用户：m10"); // 第 11 条，保留
  expect(sent).not.toContain("用户：m9"); // 第 10 条，被截掉

  await tutor.summarizeNote(history);
  sent = chat.chat.mock.calls[1][0].find(m => m.role === "user")!.content;
  expect(sent).toContain("用户：m10");
  expect(sent).not.toContain("用户：m9");
});
