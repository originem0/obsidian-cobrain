import { estimateTokens, historyCutoff, historyTokens, summaryBatches } from "./context";
import type { ChatMsg } from "../llm/chatClient";

test("短消息不按轮数截断，100 条仍可完整进入窗口", () => {
  const history: ChatMsg[] = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `消息${i}` }));
  expect(historyCutoff(history, 10000)).toBe(0);
});
test("窗口按容量留下连续后缀，不能从孤立的 assistant 开始", () => {
  const history: ChatMsg[] = [
    { role: "user", content: "长".repeat(200) }, { role: "assistant", content: "长".repeat(200) },
    { role: "user", content: "最近的问题" }, { role: "assistant", content: "最近的回答" },
  ];
  const cutoff = historyCutoff(history, 100);
  expect(cutoff).toBe(2);
  expect(historyTokens(history.slice(cutoff))).toBeLessThanOrEqual(100);
});
test("超长单条消息分批完整进入摘要，字符不丢失", () => {
  const content = "很长的原文🙂以及ASCII".repeat(500);
  const batches = summaryBatches([{ role: "user", content }], 800);
  expect(batches.length).toBeGreaterThan(2);
  expect(batches.flat().map(m => m.content).join("")).toBe(content);
  for (const batch of batches) expect(historyTokens(batch)).toBeLessThanOrEqual(801);
  expect(estimateTokens("中文")).toBe(4);
});
