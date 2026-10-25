import type { ChatMsg } from "../llm/chatClient";
import type { ContextSummaryState } from "./session";

// 无需引入 tokenizer。按非 ASCII 字符 2 token、ASCII 约 3 字符/token 保守估算；设置中标明是估算预算。
export function estimateTokens(text: string): number {
  let ascii = 0, unicode = 0;
  for (const c of text) c.charCodeAt(0) < 128 ? ascii++ : unicode++;
  return Math.ceil(ascii / 3) + unicode * 2;
}
export function messageTokens(m: ChatMsg): number { return estimateTokens(m.content) + 8; }
export function historyTokens(history: ChatMsg[]): number { return history.reduce((n, m) => n + messageTokens(m), 0); }

export function historyCutoff(history: ChatMsg[], budget: number, alreadyCovered = 0): number {
  let cutoff = history.length, used = 0;
  for (let i = history.length - 1; i >= alreadyCovered; i--) {
    const cost = messageTokens(history[i]);
    if (used + cost > budget) break;
    cutoff = i;
    used += cost;
  }
  // 以用户发言开始近期窗口，避免只留下一个脱离提问的回答。
  while (cutoff < history.length && history[cutoff].role === "assistant") cutoff++;
  return Math.max(alreadyCovered, cutoff);
}

export function summaryBatches(messages: ChatMsg[], budget: number): ChatMsg[][] {
  const batches: ChatMsg[][] = [];
  let batch: ChatMsg[] = [], used = 0;
  const limit = Math.max(256, budget);
  for (const m of messages) {
    // 单条长消息也完整分批进入摘要，不以 slice 截掉尾部。
    let piece = "";
    let pieceTokens = 8;
    const pieces: ChatMsg[] = [];
    for (const c of m.content) {
      const cost = c.charCodeAt(0) < 128 ? 1 / 3 : 2;
      if (piece && pieceTokens + cost > limit) {
        pieces.push({ role: m.role, content: piece }); piece = ""; pieceTokens = 8;
      }
      piece += c; pieceTokens += cost;
    }
    pieces.push({ role: m.role, content: piece });
    for (const part of pieces) {
      const cost = messageTokens(part);
      if (batch.length && used + cost > limit) { batches.push(batch); batch = []; used = 0; }
      batch.push(part); used += cost;
    }
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function validSummary(summary: ContextSummaryState | null | undefined, length: number): ContextSummaryState | null {
  return summary?.text.trim() && Number.isInteger(summary.coveredCount)
    && summary.coveredCount >= 0 && summary.coveredCount <= length ? summary : null;
}
