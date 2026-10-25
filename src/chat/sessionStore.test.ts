import { SessionStore } from "./sessionStore";
import { newSession, migrateLegacyDrafts, conversationMarkdown, normalizeSession } from "./session";
import type { DataAdapter } from "obsidian";

function fixture() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const adapter = {
    exists: jest.fn(async (p: string) => files.has(p) || folders.has(p)),
    mkdir: jest.fn(async (p: string) => { folders.add(p); }),
    list: jest.fn(async (p: string) => ({ files: [...files.keys()].filter(f => f.startsWith(p + "/")), folders: [] })),
    read: jest.fn(async (p: string) => { if (!files.has(p)) throw new Error("missing"); return files.get(p)!; }),
    write: jest.fn(async (p: string, text: string) => { files.set(p, text); }),
    remove: jest.fn(async (p: string) => { files.delete(p); }),
  };
  return { files, adapter, store: new SessionStore(adapter as unknown as DataAdapter, "plugin/sessions") };
}
test("会话超过三个，原文超过 80 条，重启后仍全部恢复且保留输入草稿", async () => {
  const { adapter, store } = fixture(); await store.init();
  const sessions = Array.from({ length: 7 }, () => newSession());
  for (const [i, session] of sessions.entries()) {
    session.title = `会话 ${i}`;
    session.history = Array.from({ length: 140 }, (_, j) => ({ role: j % 2 ? "assistant" : "user", content: `原文 ${i}-${j}` }));
    session.composer = "还没发出的下一问";
    await store.save(session);
  }
  const reloaded = new SessionStore(adapter as unknown as DataAdapter, "plugin/sessions"); await reloaded.init();
  expect(reloaded.list()).toHaveLength(7);
  for (const session of sessions) {
    const restored = await reloaded.get(session.id);
    expect(restored.history).toEqual(session.history);
    expect(restored.composer).toBe(session.composer);
  }
  expect(reloaded.warnings).toEqual([]);
});
test("旧草稿迁移不再截断，并保留历史图片附件及来源", () => {
  const history = Array.from({ length: 120 }, (_, i) => ({ role: "user", content: `m${i}` }));
  const sessions = migrateLegacyDrafts({ 1: { history, sources: ["资料.md"], lastImageEmbed: "![[old.png]]", contextSummary: { text: "旧摘要", coveredCount: 20 } } });
  expect(sessions[0].history).toHaveLength(121);
  expect(sessions[0].history[0].content).toBe("m0");
  expect(sessions[0].history.at(-1)?.content).toContain("old.png");
  expect(sessions[0].contextSummary?.coveredCount).toBe(20);
  expect(sessions[0].sources).toEqual(["资料.md"]);
  expect(conversationMarkdown(sessions[0])).toContain("m119");
});
test("写入序列化，旧快照不能覆盖较新的消息", async () => {
  const { store } = fixture(); await store.init();
  const session = newSession();
  const first = store.save(session);
  session.history.push({ role: "user", content: "新的消息" });
  const second = store.save(session);
  await Promise.all([first, second]); await store.flush();
  expect((await store.get(session.id)).history[0].content).toBe("新的消息");
});
test("会话主文件损坏时恢复上一次备份；目录损坏时扫描原文件恢复", async () => {
  const { files, adapter, store } = fixture(); await store.init();
  const session = newSession(); session.history.push({ role: "user", content: "已保存的原文" });
  await store.save(session); session.composer = "第二版"; await store.save(session);
  files.set(`plugin/sessions/${session.id}.json`, "{bad");
  files.set("plugin/sessions/index.json", "{bad"); files.set("plugin/sessions/index.json.bak", "{bad");
  const reloaded = new SessionStore(adapter as unknown as DataAdapter, "plugin/sessions"); await reloaded.init();
  expect((await reloaded.get(session.id)).history[0].content).toBe("已保存的原文");
  expect(reloaded.warnings.some(w => w.includes("备份恢复"))).toBe(true);
  expect(reloaded.list()).toHaveLength(1);
});
test("磁盘写失败会拒绝保存，保留可导出的内存原文；下一次写入仍可继续", async () => {
  const { adapter, store } = fixture(); await store.init();
  const session = newSession(); await store.save(session);
  adapter.write.mockRejectedValueOnce(new Error("disk full"));
  session.history.push({ role: "user", content: "不能丢掉这句话" });
  await expect(store.save(session)).rejects.toThrow("disk full");
  expect(conversationMarkdown(await store.get(session.id))).toContain("不能丢掉这句话");
  await store.save(session);
});
test("删除后迟到保存不能复活会话，非法路径不能写出会话目录", async () => {
  const { files, store } = fixture(); await store.init();
  const session = newSession(); await store.save(session); await store.delete(session.id);
  await expect(store.save(session)).rejects.toThrow("已删除");
  session.id = "../../secret";
  await expect(store.save(session)).rejects.toThrow("标识无效");
  expect([...files.keys()].some(p => p.includes("secret"))).toBe(false);
});


test("修复损坏的消息格式后不沿用错位的摘要边界", () => {
  const session = newSession();
  const restored = normalizeSession({ ...session, history: [
    { role: "user", content: "第一问" }, { role: "system", content: "非法历史角色" },
    { role: "assistant", content: "第一答" }, { role: "user", content: "第二问" },
  ], contextSummary: { text: "旧摘要", coveredCount: 2 } });
  expect(restored?.history).toHaveLength(3);
  expect(restored?.contextSummary).toBeNull();
});


test("完整会话导出包括选文快照及材料归属", () => {
  const session = newSession([{ id: "sel", path: "原文.md", kind: "selection", origin: "external", text: "原作者的第一句话。\n原作者的第二句话。" }]);
  const markdown = conversationMarkdown(session);
  expect(markdown).toContain("外部材料");
  expect(markdown).toContain("> 原作者的第一句话。");
  expect(markdown).toContain("> 原作者的第二句话。");
});
