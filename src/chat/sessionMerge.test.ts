import { compareClocks, mergeClocks, mergeSessions, tick } from "./sessionMerge";
import { newSession, type ChatSession } from "./session";

function session(patch: Partial<ChatSession> = {}): ChatSession {
  return { ...newSession(), id: "chat-a", createdAt: 1, updatedAt: 1, ...patch };
}
const q1 = { role: "user" as const, content: "第一问" }, a1 = { role: "assistant" as const, content: "第一答" };
const q2 = { role: "user" as const, content: "第二问" }, a2 = { role: "assistant" as const, content: "第二答" };

test("版本向量区分相同、先后与并发", () => {
  expect(compareClocks({ a: 1 }, { a: 1 })).toBe("equal");
  expect(compareClocks({}, { a: 1 })).toBe("before");
  expect(compareClocks({ a: 2, b: 1 }, { a: 1 })).toBe("after");
  expect(compareClocks({ a: 2 }, { a: 1, b: 1 })).toBe("concurrent");
  expect(mergeClocks({ a: 2, b: 1 }, { a: 1, c: 4 })).toEqual({ a: 2, b: 1, c: 4 });
  expect(tick({ a: 2 }, "b")).toEqual({ a: 2, b: 1 });
});

test("一边追加回答、另一边只改草稿时合并两边", () => {
  const base = session({ history: [q1] });
  const local = session({ history: [q1], composer: "手机上的草稿" });
  const remote = session({ history: [q1, a1], updatedAt: 5 });
  expect(mergeSessions(base, local, remote)).toMatchObject({ history: [q1, a1], composer: "手机上的草稿", updatedAt: 5 });
});

test("另一端已经发出的草稿不在本机复活，本机改过的草稿保留", () => {
  const base = session({ history: [q1, a1], composer: "第二问" });
  const sent = session({ history: [q1, a1, q2, a2] });
  expect(mergeSessions(base, base, sent)?.composer).toBe("");
  const edited = session({ history: [q1, a1], composer: "第二问，补充一句" });
  expect(mergeSessions(base, edited, sent)).toMatchObject({ history: [q1, a1, q2, a2], composer: "第二问，补充一句" });
});

test("两边追加了不同的消息或写了不同的草稿才算冲突", () => {
  const base = session({ history: [q1] });
  expect(mergeSessions(base, session({ history: [q1, a1] }), session({ history: [q1, q2] }))).toBeNull();
  expect(mergeSessions(base, session({ history: [q1], composer: "甲" }), session({ history: [q1], composer: "乙" }))).toBeNull();
});

test("材料只有一边改过时取那一边，两边改得不同则冲突", () => {
  const doc = { id: "document:a.md", path: "a.md", kind: "document" as const, origin: "unknown" as const };
  const base = session({ materials: [doc] });
  const marked = session({ materials: [{ ...doc, origin: "self" }] });
  expect(mergeSessions(base, base, marked)?.materials).toEqual(marked.materials);
  expect(mergeSessions(base, marked, base)?.materials).toEqual(marked.materials);
  expect(mergeSessions(base, marked, session({ materials: [] }))).toBeNull();
});

test("摘要取覆盖更多的一份，来源合并去重", () => {
  const base = session({ history: [q1, a1] });
  const local = session({ history: [q1, a1, q2], sources: ["a.md"], contextSummary: { text: "早期摘要", coveredCount: 1 } });
  const remote = session({ history: [q1, a1], sources: ["b.md"], contextSummary: { text: "较新摘要", coveredCount: 2 } });
  expect(mergeSessions(base, local, remote)).toMatchObject({
    history: [q1, a1, q2], sources: ["a.md", "b.md"], contextSummary: { text: "较新摘要", coveredCount: 2 },
  });
});

test("没有基准时按历史前缀合并，只有一边有草稿时保留它", () => {
  const ahead = session({ history: [q1, a1], composer: "" });
  const behind = session({ history: [q1], composer: "还没发的问题" });
  expect(mergeSessions(null, behind, ahead)).toMatchObject({ history: [q1, a1], composer: "还没发的问题" });
  expect(mergeSessions(null, session({ history: [q1, a1] }), session({ history: [q1, q2] }))).toBeNull();
});
