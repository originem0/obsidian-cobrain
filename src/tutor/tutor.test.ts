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
    queryRewriteEnabled: false, // 默认关：无关测试不被额外的改写调用干扰，改写测试单独开
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

const EMBED_OK = { embedBaseUrl: "https://embed.example/v1", embedKey: "k", embedModel: "e" };

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
  const tutor = new Tutor(retriever as any, chat as any, settings(EMBED_OK));

  const out = await tutor.ask([], "问题");

  expect(retriever.retrieve).toHaveBeenCalledWith("问题", 8);
  expect(out.sources).toEqual(["a.md"]);
  expect(out.related).toHaveLength(1);
});

test("ask 检索一完成就回调 onRetrieved（先于主回答请求）", async () => {
  const events: string[] = [];
  const retriever = {
    retrieve: jest.fn(async () => {
      events.push("retrieve");
      return [{ path: "a.md", heading: "", text: "片段", score: 0.9 }];
    }),
  };
  const chat = { chat: jest.fn(async () => { events.push("chat"); return "回答"; }) };
  const tutor = new Tutor(retriever as any, chat as any, settings(EMBED_OK));

  await tutor.ask([], "问题", {
    onRetrieved: (related, sources) => {
      events.push("onRetrieved");
      expect(related).toHaveLength(1);
      expect(sources).toEqual(["a.md"]);
    },
  });

  expect(events).toEqual(["retrieve", "onRetrieved", "chat"]);
});

test("ask 开启多轮检索改写：先改写 query 再检索，主请求仍发用户原话", async () => {
  const retriever = { retrieve: jest.fn(async () => []) };
  const chat = {
    chat: jest.fn<Promise<string>, [ChatMsg[]]>()
      .mockResolvedValueOnce("「注意力机制的缺点」") // 改写调用（带引号，应剥掉）
      .mockResolvedValueOnce("回答"),               // 主对话
  };
  const tutor = new Tutor(retriever as any, chat as any, settings({ ...EMBED_OK, queryRewriteEnabled: true }));
  const history: ChatMsg[] = [
    { role: "user", content: "注意力机制是什么" },
    { role: "assistant", content: "……" },
  ];

  await tutor.ask(history, "那它的缺点呢？");

  expect(chat.chat).toHaveBeenCalledTimes(2);
  expect(retriever.retrieve).toHaveBeenCalledWith("注意力机制的缺点", 8);
  const mainMsgs = chat.chat.mock.calls[1][0];
  expect(mainMsgs[mainMsgs.length - 1].content).toBe("那它的缺点呢？");
});

test("ask 改写失败回退原文检索，不阻断对话", async () => {
  const retriever = { retrieve: jest.fn(async () => []) };
  const chat = {
    chat: jest.fn()
      .mockRejectedValueOnce(new Error("改写挂了"))
      .mockResolvedValueOnce("回答"),
  };
  const tutor = new Tutor(retriever as any, chat as any, settings({ ...EMBED_OK, queryRewriteEnabled: true }));

  const out = await tutor.ask([{ role: "user", content: "上文" }], "那它呢？");

  expect(retriever.retrieve).toHaveBeenCalledWith("那它呢？", 8);
  expect(out.reply).toBe("回答");
});

test("ask 无历史（首问）或开关关闭时不做改写", async () => {
  const retriever = { retrieve: jest.fn(async () => []) };
  const chat = { chat: jest.fn(async () => "回答") };

  const enabled = new Tutor(retriever as any, chat as any, settings({ ...EMBED_OK, queryRewriteEnabled: true }));
  await enabled.ask([], "首问");
  expect(chat.chat).toHaveBeenCalledTimes(1); // 首问没有指代可补，不该多打一次改写

  chat.chat.mockClear();
  const disabled = new Tutor(retriever as any, chat as any, settings(EMBED_OK));
  await disabled.ask([{ role: "user", content: "上文" }], "那它呢？");
  expect(chat.chat).toHaveBeenCalledTimes(1);
  expect(retriever.retrieve).toHaveBeenLastCalledWith("那它呢？", 8);
});

test("ask 把滚动摘要作为材料块注入在窗口内历史之前", async () => {
  const chat = { chat: jest.fn(async (_msgs: ChatMsg[]) => "回答") };
  const tutor = new Tutor({ retrieve: jest.fn() } as any, chat as any, settings());
  const history: ChatMsg[] = [{ role: "user", content: "窗口内的第一条" }];

  await tutor.ask(history, "新问题", { earlierSummary: "此前讨论过量化与分片" });

  const sent = chat.chat.mock.calls[0][0];
  const summaryIdx = sent.findIndex(m => m.content.includes("此前讨论过量化与分片"));
  const historyIdx = sent.findIndex(m => m.content === "窗口内的第一条");
  expect(summaryIdx).toBeGreaterThan(-1);
  expect(sent[summaryIdx].content).toContain("滚动摘要");
  expect(summaryIdx).toBeLessThan(historyIdx); // 摘要在历史之前：时间顺序上它是「更早发生的事」
});

test("updateRollingSummary 把已有摘要与新滑出消息一起发给模型，返回净文本", async () => {
  const chat = { chat: jest.fn(async (_msgs: ChatMsg[]) => "  合并后的摘要 \n") };
  const tutor = new Tutor({ retrieve: jest.fn() } as any, chat as any, settings());

  const out = await tutor.updateRollingSummary("旧摘要", [
    { role: "user", content: "滑出的问题" },
    { role: "assistant", content: "滑出的回答" },
  ]);

  expect(out).toBe("合并后的摘要");
  const sent = (chat.chat.mock.calls[0][0]).find(m => m.role === "user")!.content;
  expect(sent).toContain("旧摘要");
  expect(sent).toContain("滑出的问题");
  expect(sent).toContain("滑出的回答");
});

test("critique / summarizeNote 可带滚动摘要作为背景材料", async () => {
  const chat = { chat: jest.fn(async (_msgs: ChatMsg[]) => "标题：T\n正文") };
  const tutor = new Tutor({ retrieve: jest.fn() } as any, chat as any, settings());
  const history: ChatMsg[] = [{ role: "user", content: "材料" }];

  await tutor.critique(history, { earlierSummary: "背景摘要" });
  let sent = (chat.chat.mock.calls[0][0]).find(m => m.role === "user")!.content;
  expect(sent).toContain("背景摘要");

  await tutor.summarizeNote(history, { earlierSummary: "背景摘要" });
  sent = (chat.chat.mock.calls[1][0]).find(m => m.role === "user")!.content;
  expect(sent).toContain("背景摘要");
});

test("conceptMap 用最近一条用户发言检索，并把整段对话作为材料", async () => {
  const retriever = { retrieve: jest.fn(async () => []) };
  const chat = { chat: jest.fn(async (_msgs: ChatMsg[]) => "```mermaid\ngraph TD\n```") };
  const tutor = new Tutor(retriever as any, chat as any, settings(EMBED_OK));

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
