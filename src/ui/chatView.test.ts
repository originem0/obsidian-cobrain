jest.mock("obsidian", () => ({
  ItemView: class {},
  WorkspaceLeaf: class {},
  MarkdownRenderer: { render: jest.fn() },
  Notice: class {},
  Modal: class {},
  App: class {},
  TFile: class {},
  Menu: class {},
  normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}), { virtual: true });

import { chatContextLimitText, chatHistoryForModel, chatStateSignature } from "./chatView";
import type { ChatMsg } from "../llm/chatClient";

test("chatStateSignature 不受 sources 顺序影响", () => {
  const history: ChatMsg[] = [{ role: "user", content: "同一轮对话" }];

  expect(chatStateSignature(history, ["b.md", "a.md"], null, null))
    .toBe(chatStateSignature(history, ["a.md", "b.md"], null, null));
});

test("chatStateSignature 能识别对话、概念图、配图变化", () => {
  const history: ChatMsg[] = [{ role: "user", content: "问题" }];
  const base = chatStateSignature(history, ["a.md"], null, null);

  expect(chatStateSignature([...history, { role: "assistant", content: "回答" }], ["a.md"], null, null))
    .not.toBe(base);
  expect(chatStateSignature(history, ["a.md"], "```mermaid\ngraph TD\n```", null))
    .not.toBe(base);
  expect(chatStateSignature(history, ["a.md"], null, "![[img.png]]"))
    .not.toBe(base);
});

test("chatHistoryForModel 只取最近 20 条，并给出准确截断提示", () => {
  const history = Array.from({ length: 23 }, (_, i): ChatMsg => ({ role: "user", content: `m${i}` }));

  const sent = chatHistoryForModel(history);

  expect(sent).toHaveLength(20);
  expect(sent[0].content).toBe("m3");
  expect(sent[19].content).toBe("m22");
  expect(chatContextLimitText(20)).toBeNull();
  expect(chatContextLimitText(23)).toBe("更早的 3 条消息已保存在草稿里，但本轮不会发给模型。");
});
