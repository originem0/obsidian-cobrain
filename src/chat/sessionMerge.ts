import type { ChatMsg } from "../llm/chatClient";
import type { ChatSession } from "./session";

// 版本向量：每台设备在一个会话上的写入次数。用来判断一份快照是否已被后来的写入包含，
// 而不是靠内容猜测；内容猜测会把另一台设备改过的草稿误判成丢失的写入。
export type Clock = Record<string, number>;

export function parseClock(raw: unknown): Clock {
  const clock: Clock = {};
  if (!raw || typeof raw !== "object") return clock;
  for (const [device, count] of Object.entries(raw)) {
    if (/^[a-zA-Z0-9_-]{1,100}$/.test(device) && Number.isInteger(count) && Number(count) > 0) clock[device] = Number(count);
  }
  return clock;
}

export function compareClocks(a: Clock, b: Clock): "equal" | "before" | "after" | "concurrent" {
  let behind = false, ahead = false;
  for (const device of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[device] ?? 0, y = b[device] ?? 0;
    if (x < y) behind = true;
    else if (x > y) ahead = true;
  }
  return behind ? (ahead ? "concurrent" : "before") : (ahead ? "after" : "equal");
}

export function mergeClocks(a: Clock, b: Clock): Clock {
  const merged: Clock = { ...a };
  for (const [device, count] of Object.entries(b)) merged[device] = Math.max(merged[device] ?? 0, count);
  return merged;
}

export function tick(clock: Clock, device: string): Clock {
  return { ...clock, [device]: (clock[device] ?? 0) + 1 };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const isPrefix = (short: ChatMsg[], long: ChatMsg[]): boolean =>
  short.length <= long.length && short.every((m, i) => m.role === long[i].role && m.content === long[i].content);

// 只有一边相对基准改过时取那一边；两边改成相同的值也不算冲突。没有基准时只认两边相同。
function choose<T>(base: T | undefined, local: T, remote: T): { value: T } | null {
  if (same(local, remote)) return { value: local };
  if (base !== undefined && same(local, base)) return { value: remote };
  if (base !== undefined && same(remote, base)) return { value: local };
  return null;
}

function mergeDraft(base: ChatSession | null, local: ChatSession, remote: ChatSession, history: ChatMsg[]): string | null {
  const chosen = choose(base?.composer, local.composer, remote.composer);
  if (chosen) return chosen.value;
  // 两边都改过草稿：已作为新提问发出的那份不再保留，只剩一边有内容时保留它。
  const appended = history.slice(base ? base.history.length : Math.min(local.history.length, remote.history.length));
  const pending = (draft: string) => appended.some(m => m.role === "user" && m.content === draft.trim()) ? "" : draft;
  const l = pending(local.composer), r = pending(remote.composer);
  if (!r.trim()) return l;
  if (!l.trim()) return r;
  return l === r ? l : null;
}

// 三方合并：base 是本机上次读到或写入的版本，没有时（恢复快照）只按历史前缀判断。
// 返回 null 表示两边的改动无法自动合并，由调用方另存副本，保证双方内容都不丢。
export function mergeSessions(base: ChatSession | null, local: ChatSession, remote: ChatSession): ChatSession | null {
  // 历史只会追加：一边是另一边的前缀就取较长的一边，两边各自追加了不同消息才是冲突。
  const history = isPrefix(local.history, remote.history) ? remote.history
    : isPrefix(remote.history, local.history) ? local.history : null;
  if (!history) return null;
  const composer = mergeDraft(base, local, remote, history);
  const materials = choose(base?.materials, local.materials, remote.materials);
  if (composer === null || !materials) return null;
  // 摘要只覆盖历史前缀，两边的摘要对较长的历史都有效，取覆盖更多的一份。
  const contextSummary = (remote.contextSummary?.coveredCount ?? -1) > (local.contextSummary?.coveredCount ?? -1)
    ? remote.contextSummary : local.contextSummary;
  const savedAt = (s: ChatSession) => s.lastSavedNote?.savedAt ?? 0;
  return {
    id: local.id,
    title: choose(base?.title, local.title, remote.title)?.value ?? local.title,
    createdAt: Math.min(local.createdAt, remote.createdAt),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    history, materials: materials.value, composer, contextSummary,
    sources: choose(base?.sources, local.sources, remote.sources)?.value
      ?? [...local.sources, ...remote.sources.filter(path => !local.sources.includes(path))],
    lastMermaid: choose(base?.lastMermaid, local.lastMermaid, remote.lastMermaid)?.value ?? local.lastMermaid ?? remote.lastMermaid,
    lastSavedNote: choose(base?.lastSavedNote, local.lastSavedNote, remote.lastSavedNote)?.value
      ?? (savedAt(remote) > savedAt(local) ? remote.lastSavedNote : local.lastSavedNote),
  };
}
