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

import {
  chatContextLimitText,
  chatHistoryForModel,
  chatStateSignature,
  consumeSavedSnapshot,
  summaryUpdatePlan,
} from "./chatView";
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

test("chatHistoryForModel 只取最近 20 条", () => {
  const history = Array.from({ length: 23 }, (_, i): ChatMsg => ({ role: "user", content: `m${i}` }));

  const sent = chatHistoryForModel(history);

  expect(sent).toHaveLength(20);
  expect(sent[0].content).toBe("m3");
  expect(sent[19].content).toBe("m22");
});

test("chatContextLimitText 按摘要覆盖进度给出准确提示", () => {
  expect(chatContextLimitText(20)).toBeNull();
  expect(chatContextLimitText(23)).toBe("更早的 3 条消息暂未发给模型（对话继续时会自动压缩成滚动摘要）。");
  expect(chatContextLimitText(30, 10)).toBe("更早的 10 条消息已压缩成滚动摘要，随本轮对话一起发给模型。");
  expect(chatContextLimitText(30, 4)).toBe("更早的 10 条消息中 4 条已压缩成滚动摘要；其余 6 条待下次压缩，本轮不发给模型。");
});

test("summaryUpdatePlan 攒批：窗口外未覆盖消息不足阈值不总结", () => {
  expect(summaryUpdatePlan(10, 0)).toBeNull(); // 没超窗
  expect(summaryUpdatePlan(25, 0)).toBeNull(); // 溢出 5 条 < 攒批 6 条
  expect(summaryUpdatePlan(26, 0)).toEqual({ from: 0, to: 6 }); // 刚够一批
  expect(summaryUpdatePlan(40, 6)).toEqual({ from: 6, to: 20 }); // 增量并入：只总结未覆盖区间
  expect(summaryUpdatePlan(40, 20)).toBeNull(); // 已全覆盖
});

test("summaryUpdatePlan 的总结区间永不侵入 20 条窗口内的消息", () => {
  const plan = summaryUpdatePlan(60, 0);

  expect(plan).toEqual({ from: 0, to: 40 }); // to = 60 - 20，窗口内的 20 条始终原文发送
});

test("consumeSavedSnapshot 不变量：保存后未再改动时，当前状态签名命中去重", () => {
  const history: ChatMsg[] = [
    { role: "user", content: "问题" },
    { role: "assistant", content: "回答" },
  ];
  const snapshot = { history, sources: ["a.md", "b.md"], mermaid: "```mermaid\ngraph TD\n```", imageEmbed: "![[i.png]]" };
  // 保存时刻的实时状态与快照一致（弹窗期间用户没动）
  const consumed = consumeSavedSnapshot(
    { lastMermaid: snapshot.mermaid, lastImageEmbed: snapshot.imageEmbed },
    snapshot,
    "notes/新笔记.md",
    1234,
  );

  // 应用消费后的实时状态：mermaid/image 清空、sources 全部移除
  const sourcesAfter = ["a.md", "b.md"].filter(s => !consumed.consumedSources.includes(s));
  const signatureAfter = chatStateSignature(history, sourcesAfter, consumed.lastMermaid, consumed.lastImageEmbed);

  expect(consumed.lastMermaid).toBeNull();
  expect(consumed.lastImageEmbed).toBeNull();
  expect(signatureAfter).toBe(consumed.lastSavedNote.stateSignature); // 再点「存为笔记」命中去重
  expect(consumed.lastSavedNote).toEqual({ stateSignature: signatureAfter, path: "notes/新笔记.md", savedAt: 1234 });
});

test("consumeSavedSnapshot 保护弹窗期间重新生成的新产物不被误清", () => {
  const history: ChatMsg[] = [{ role: "user", content: "问题" }];
  const snapshot = { history, sources: [], mermaid: "旧图", imageEmbed: "![[旧图.png]]" };

  // 弹窗/出图期间用户重新生成了概念图和配图：实时状态 ≠ 快照
  const consumed = consumeSavedSnapshot(
    { lastMermaid: "新图", lastImageEmbed: "![[新图.png]]" },
    snapshot,
    "n.md",
    1,
  );

  expect(consumed.lastMermaid).toBe("新图");
  expect(consumed.lastImageEmbed).toBe("![[新图.png]]");
  // 且新产物在场时签名不等于保存记录 → 下次保存不会被去重误拦
  const signatureAfter = chatStateSignature(history, [], consumed.lastMermaid, consumed.lastImageEmbed);
  expect(signatureAfter).not.toBe(consumed.lastSavedNote.stateSignature);
});
