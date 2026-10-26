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
  const recovered = await Promise.all(reloaded.list().map(info => reloaded.get(info.id)));
  expect(recovered.some(s => s.composer === "第二版" && s.history[0].content === "已保存的原文")).toBe(true);
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

test("材料只保留有效条目，未知归属按未确认处理", () => {
  const restored = normalizeSession({ ...newSession(), materials: [
    { id: "doc", path: "a.md", kind: "document", origin: "self", heading: 3 },
    { id: "doc", path: "重复.md", kind: "document", origin: "self" },
    { id: "sel", path: "b.md", kind: "selection", origin: "bogus", text: "原文", heading: "H" },
    { id: "无原文", path: "c.md", kind: "selection", origin: "self" },
    { id: "图片", path: "d.png", kind: "image", origin: "self" },
    { path: "缺标识.md", kind: "document" }, null, "a.md",
  ] });
  expect(restored?.materials).toEqual([
    { id: "doc", path: "a.md", kind: "document", origin: "self" },
    { id: "sel", path: "b.md", kind: "selection", origin: "unknown", text: "原文", heading: "H" },
  ]);
});


test("完整会话导出包括选文快照及材料归属", () => {
  const session = newSession([{ id: "sel", path: "原文.md", kind: "selection", origin: "external", text: "原作者的第一句话。\n原作者的第二句话。" }]);
  const markdown = conversationMarkdown(session);
  expect(markdown).toContain("外部材料");
  expect(markdown).toContain("> 原作者的第一句话。");
  expect(markdown).toContain("> 原作者的第二句话。");
});

test("另一端的新回答不会被本地旧草稿覆盖，冲突保留为独立会话", async () => {
  const { adapter, files, store } = fixture(); await store.init();
  const session = newSession(); session.history.push({ role: "user", content: "原问题" }); await store.save(session);
  const originalId = session.id;
  const other = new SessionStore(adapter as unknown as DataAdapter, "plugin/sessions"); await other.init();
  const local = await other.get(originalId); local.composer = "手机上未发送的问题";
  session.history.push({ role: "assistant", content: "桌面的新回答" }); await store.save(session);
  await other.save(local);
  expect(local.id).not.toBe(originalId);
  expect(local.title).toContain("同步副本");
  expect(JSON.parse(files.get(`plugin/sessions/${originalId}.json`)!).history.at(-1).content).toBe("桌面的新回答");
  expect(JSON.parse(files.get(`plugin/sessions/${local.id}.json`)!).composer).toBe("手机上未发送的问题");
  expect(other.list()).toHaveLength(2);
});

test("无本地改动时读取或保存会接续外部更新，不生成冲突副本", async () => {
  const { adapter, store } = fixture(); await store.init();
  const session = newSession(); await store.save(session);
  const other = new SessionStore(adapter as unknown as DataAdapter, "plugin/sessions"); await other.init();
  const local = await other.get(session.id);
  session.history.push({ role: "user", content: "另一端的第一问" }); await store.save(session);
  expect(await other.get(session.id)).toBe(local);
  expect(local.history).toEqual(session.history);
  session.history.push({ role: "assistant", content: "新回答" }); await store.save(session);
  local.updatedAt++;
  await other.save(local);
  expect(local.history).toEqual(session.history);
  expect(other.list()).toHaveLength(1);
});

test("冲突分流后已经入队的下一次保存继续写本地副本", async () => {
  const { adapter, files, store } = fixture(); await store.init();
  const session = newSession(); await store.save(session); const originalId = session.id;
  const other = new SessionStore(adapter as unknown as DataAdapter, "plugin/sessions"); await other.init();
  const local = await other.get(originalId); local.composer = "草稿一";
  session.history.push({ role: "user", content: "外部新问题" }); await store.save(session);
  const first = other.save(local); local.composer = "草稿二"; const second = other.save(local);
  await Promise.all([first, second]);
  expect(other.list()).toHaveLength(2);
  expect(JSON.parse(files.get(`plugin/sessions/${local.id}.json`)!).composer).toBe("草稿二");
  expect(JSON.parse(files.get(`plugin/sessions/${originalId}.json`)!).history[0].content).toBe("外部新问题");
});

test("同时通过版本检查的两个写入可在重启后找回双方的原文", async () => {
  const { adapter, files, store } = fixture(); await store.init();
  const a = newSession(); a.history.push({ role: "user", content: "共同问题" }); await store.save(a);
  const other = new SessionStore(adapter as unknown as DataAdapter, "plugin/sessions"); await other.init();
  const b = await other.get(a.id);
  a.history.push({ role: "assistant", content: "设备 A 的回答" });
  b.history.push({ role: "assistant", content: "设备 B 的回答" });
  let arrivals = 0, resume!: () => void;
  const both = new Promise<void>(resolve => { resume = resolve; });
  const primary = `plugin/sessions/${a.id}.json`;
  adapter.write.mockImplementation(async (p, text) => {
    if (p === primary) { if (++arrivals === 2) resume(); await both; }
    files.set(p, text);
  });
  await Promise.all([store.save(a), other.save(b)]);
  adapter.write.mockImplementation(async (p, text) => { files.set(p, text); });
  const reloaded = new SessionStore(adapter as unknown as DataAdapter, "plugin/sessions"); await reloaded.init();
  const histories = await Promise.all(reloaded.list().map(async info => conversationMarkdown(await reloaded.get(info.id))));
  expect(histories.some(text => text.includes("设备 A 的回答"))).toBe(true);
  expect(histories.some(text => text.includes("设备 B 的回答"))).toBe(true);
  expect(reloaded.warnings.some(text => text.includes("恢复快照"))).toBe(true);
});

test("主文件尚未写入时中断，可从独立快照恢复未发送草稿", async () => {
  const { adapter, store } = fixture(); await store.init();
  const session = newSession(); await store.save(session);
  session.composer = "尚未写进主文件的草稿";
  const write = adapter.write.getMockImplementation()!;
  adapter.write.mockImplementation(async (p, text) => {
    if (p.endsWith(`${session.id}.json.bak`)) throw new Error("write interrupted");
    await write(p, text);
  });
  await expect(store.save(session)).rejects.toThrow("write interrupted");
  adapter.write.mockImplementation(write);
  const reloaded = new SessionStore(adapter as unknown as DataAdapter, "plugin/sessions"); await reloaded.init();
  const sessions = await Promise.all(reloaded.list().map(info => reloaded.get(info.id)));
  expect(sessions.some(s => s.composer === "尚未写进主文件的草稿")).toBe(true);
});

test("会话目录合并保留另一端新增的会话，并可刷新发现它", async () => {
  const { adapter, store } = fixture(); await store.init();
  const other = new SessionStore(adapter as unknown as DataAdapter, "plugin/sessions"); await other.init();
  const a = newSession(), b = newSession(); await store.save(a); await other.save(b);
  await store.refresh();
  expect(store.list().map(info => info.id)).toEqual(expect.arrayContaining([a.id, b.id]));
});

test("外部改动或删除之后不覆盖或复活原会话", async () => {
  const { files, store } = fixture(); await store.init();
  const session = newSession(); await store.save(session); const originalId = session.id;
  files.delete(`plugin/sessions/${originalId}.json`);
  session.composer = "本地仍有草稿";
  await store.save(session);
  expect(session.id).not.toBe(originalId);
  expect(files.has(`plugin/sessions/${originalId}.json`)).toBe(false);
  const changed = { ...session, history: [{ role: "user", content: "外部修改" }] };
  files.set(`plugin/sessions/${session.id}.json`, JSON.stringify(changed));
  await expect(store.delete(session.id)).rejects.toThrow("其它设备更新");
  expect(files.has(`plugin/sessions/${session.id}.json`)).toBe(true);
});
