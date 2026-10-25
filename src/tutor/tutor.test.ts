jest.mock("obsidian", () => ({ PluginSettingTab: class {}, TFile: class {} }), { virtual: true });
import { Tutor } from "./tutor";
import { DEFAULT_SETTINGS } from "../settings";
import type { ChatMsg } from "../llm/chatClient";
import type { ContextSummaryState } from "../chat/session";
import { historyTokens } from "../chat/context";

const summaryCall = (messages: ChatMsg[]) => messages[0].content.startsWith("维护一段长对话");
function fixture(budget = 24000) {
  const chat = { chat: jest.fn(async (messages: ChatMsg[], _opts?: unknown): Promise<string> => summaryCall(messages) ? "连续摘要，保留用户判断与未决问题" : "标题：新笔记\n回答正文") };
  const tutor = new Tutor(chat as any, { ...DEFAULT_SETTINGS, contextBudgetTokens: budget, embedBaseUrl: "configured", embedKey: "key", embedModel: "embed" });
  return { tutor, chat };
}
test("配置嵌入端点后普通对话仍只有主回答调用，没有检索改写", async () => {
  const { tutor, chat } = fixture();
  const result = await tutor.ask([{ role: "user", content: "之前的问题" }, { role: "assistant", content: "之前的回答" }], "那它呢");
  expect(chat.chat).toHaveBeenCalledTimes(1);
  expect(result.sources).toEqual([]);
  expect(chat.chat.mock.calls[0][0].at(-1)?.content).toBe("那它呢");
});
test("100 条短消息全部发送，摆脱固定二十条窗口", async () => {
  const { tutor, chat } = fixture();
  const history: ChatMsg[] = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `第${i}条原文` }));
  await tutor.ask(history, "继续");
  expect(chat.chat).toHaveBeenCalledTimes(1);
  const sent = chat.chat.mock.calls[0][0];
  for (const message of history) expect(sent).toContainEqual(message);
});
test("容量不足时先完成摘要，再发送连续后缀；所有移出的原文都进入摘要请求", async () => {
  const { tutor, chat } = fixture(4096);
  const history: ChatMsg[] = Array.from({ length: 36 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `唯一消息编号-${i}-` + "详细论证".repeat(50) }));
  let summary: ContextSummaryState | null = null;
  await tutor.ask(history, "继续深入", { onSummary: s => { summary = s; } });
  expect(summary).not.toBeNull();
  const cutoff = (summary as unknown as ContextSummaryState).coveredCount;
  expect(cutoff).toBeGreaterThan(0);
  const final = chat.chat.mock.calls.at(-1)![0];
  const summarized = chat.chat.mock.calls.filter(([m]) => summaryCall(m)).flatMap(([m]) => m.slice(2)).map(m => m.content).join("");
  for (const m of history.slice(0, cutoff)) expect(summarized).toContain(m.content);
  for (const m of history.slice(cutoff)) expect(final).toContainEqual(m);
  expect(historyTokens(final)).toBeLessThanOrEqual(4096);
  expect(history).toHaveLength(36);
});
test("摘要失败时停止主请求，不把缺失旧消息的窗口发给模型", async () => {
  const { tutor, chat } = fixture(4096);
  chat.chat.mockRejectedValueOnce(new Error("summary failed"));
  const history: ChatMsg[] = Array.from({ length: 20 }, () => ({ role: "user", content: "原文".repeat(300) }));
  await expect(tutor.ask(history, "继续")).rejects.toThrow("summary failed");
  expect(chat.chat).toHaveBeenCalledTimes(1);
  expect(history).toHaveLength(20);
});
test("摘要在途被停止时，迟到摘要不能触发主回答或更新保存状态", async () => {
  const { tutor, chat } = fixture(4096);
  let resolve!: (text: string) => void;
  chat.chat.mockImplementationOnce(() => new Promise<string>(done => { resolve = done; }));
  const controller = new AbortController(); const onSummary = jest.fn();
  const promise = tutor.ask(Array.from({ length: 30 }, () => ({ role: "user", content: "原文".repeat(100) })), "继续", { signal: controller.signal, onSummary });
  controller.abort(); resolve("迟到的摘要");
  await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  expect(chat.chat).toHaveBeenCalledTimes(1); expect(onSummary).not.toHaveBeenCalled();
});
test("只注入明确附加的文档，并说明外部作者与用户立场的区别", async () => {
  const { tutor, chat } = fixture();
  const result = await tutor.ask([], "分析这篇文章", { documents: [{
    reference: { id: "doc", path: "外部/文章.md", kind: "document", origin: "external" },
    text: "原作者的完整论证，包括文章末尾的结论。", author: "原作者",
  }] });
  const sent = chat.chat.mock.calls[0][0];
  expect(result.sources).toEqual(["外部/文章.md"]);
  expect(sent[0].content).toContain("不等于用户认可它");
  expect(sent.map(m => m.content).join("\n")).toContain("文章末尾的结论");
  expect(sent.map(m => m.content).join("\n")).toContain("原作者");
});
test("推敲、概念图和存笔记也使用容量窗口，超过四十条的短历史不被截断", async () => {
  const { tutor, chat } = fixture();
  const history: ChatMsg[] = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `原文${i}` }));
  await tutor.critique(history); await tutor.conceptMap(history); await tutor.summarizeNote(history);
  expect(chat.chat).toHaveBeenCalledTimes(3);
  for (const [sent] of chat.chat.mock.calls) for (const m of history) expect(sent).toContainEqual(m);
});


test("迁移的旧摘要包含已被旧版删掉的原文信息，即使近期历史很短也不能丢弃", async () => {
  const { tutor, chat } = fixture();
  await tutor.ask([
    { role: "user", content: "摘要已覆盖的问题" },
    { role: "assistant", content: "摘要已覆盖的回答" },
    { role: "user", content: "近期的问题" },
  ], "继续", { summary: { text: "这里还保存着旧版本窗口之外的重要判断。", coveredCount: 2 } });
  const sent = chat.chat.mock.calls[0][0];
  expect(sent.some(m => m.content.includes("旧版本窗口之外的重要判断"))).toBe(true);
  expect(sent).toContainEqual({ role: "user", content: "近期的问题" });
  expect(chat.chat).toHaveBeenCalledTimes(1);
});
