import { SessionStore } from "./sessionStore";
import { newSession, migrateLegacyDrafts, conversationMarkdown, normalizeSession, type ChatSession } from "./session";
import type { DataAdapter } from "obsidian";

const DIR = "plugin/sessions";
function fixture(deviceId = "device-a") {
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
  return { files, adapter, store: open(adapter, deviceId) };
}
// 同一个 adapter 模拟同步后的共享目录；设备标识相同表示同一台设备重启。
function open(adapter: unknown, deviceId: string, onChanged?: (session: ChatSession, previousId: string) => void): SessionStore {
  return new SessionStore(adapter as DataAdapter, DIR, undefined, onChanged, deviceId);
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
  const reloaded = open(adapter, "device-a"); await reloaded.init();
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


test("面板内容过期时编辑草稿，另一端的新回答与草稿自动合并，不生成副本", async () => {
  const { adapter, files, store } = fixture(); await store.init();
  const session = newSession(); session.history.push({ role: "user", content: "原问题" }); await store.save(session);
  const changed = jest.fn();
  const phone = open(adapter, "device-b", changed); await phone.init();
  const local = await phone.get(session.id); local.composer = "手机上未发送的问题";
  session.history.push({ role: "assistant", content: "桌面的新回答" }); await store.save(session);
  await phone.save(local);
  expect(local.id).toBe(session.id);
  expect(local.history.at(-1)?.content).toBe("桌面的新回答");
  expect(changed).toHaveBeenCalledWith(local, session.id);
  const saved = JSON.parse(files.get(`${DIR}/${session.id}.json`)!);
  expect(saved.history.at(-1).content).toBe("桌面的新回答");
  expect(saved.composer).toBe("手机上未发送的问题");
  expect(phone.list()).toHaveLength(1);
  expect(phone.warnings).toEqual([]);
});

test("读取时接上外部更新而不写盘，本地草稿留到下一次保存", async () => {
  const { adapter, files, store } = fixture(); await store.init();
  const session = newSession(); session.history.push({ role: "user", content: "原问题" }); await store.save(session);
  const phone = open(adapter, "device-b"); await phone.init();
  const local = await phone.get(session.id); local.composer = "手机草稿";
  session.history.push({ role: "assistant", content: "桌面的新回答" }); await store.save(session);
  const before = files.get(`${DIR}/${session.id}.json`);
  expect(await phone.get(session.id)).toBe(local);
  expect(local.history.at(-1)?.content).toBe("桌面的新回答");
  expect(local.composer).toBe("手机草稿");
  expect(files.get(`${DIR}/${session.id}.json`)).toBe(before);
  await phone.save(local);
  const saved = JSON.parse(files.get(`${DIR}/${session.id}.json`)!);
  expect([saved.history.length, saved.composer]).toEqual([2, "手机草稿"]);
});

test("无本地改动时读取或保存会接续外部更新，不生成冲突副本", async () => {
  const { adapter, store } = fixture(); await store.init();
  const session = newSession(); await store.save(session);
  const other = open(adapter, "device-b"); await other.init();
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

test("另一端已发出的草稿不会在本机复活", async () => {
  const { adapter, files, store } = fixture(); await store.init();
  const session = newSession(); session.composer = "第二问"; await store.save(session);
  const phone = open(adapter, "device-b"); await phone.init();
  const local = await phone.get(session.id);
  session.history.push({ role: "user", content: "第二问" }, { role: "assistant", content: "回答" }); session.composer = "";
  await store.save(session);
  local.updatedAt++; await phone.save(local);
  expect(local.composer).toBe("");
  expect(JSON.parse(files.get(`${DIR}/${session.id}.json`)!).composer).toBe("");
});

test("两端追加了不同的消息才另存副本，之后入队的保存继续写本地副本", async () => {
  const { adapter, files, store } = fixture(); await store.init();
  const session = newSession(); await store.save(session); const originalId = session.id;
  const phone = open(adapter, "device-b"); await phone.init();
  const local = await phone.get(originalId); local.history.push({ role: "user", content: "手机上的问题" });
  session.history.push({ role: "user", content: "外部新问题" }); await store.save(session);
  const first = phone.save(local); local.composer = "草稿二"; const second = phone.save(local);
  await Promise.all([first, second]);
  expect(local.id).not.toBe(originalId);
  expect(local.title).toContain("同步副本");
  expect(phone.list()).toHaveLength(2);
  const copy = JSON.parse(files.get(`${DIR}/${local.id}.json`)!);
  expect([copy.history[0].content, copy.composer]).toEqual(["手机上的问题", "草稿二"]);
  expect(JSON.parse(files.get(`${DIR}/${originalId}.json`)!).history[0].content).toBe("外部新问题");
});

test("同步工具按后写覆盖丢掉的并发写入，写入方重启后保留为副本，不重复", async () => {
  const { adapter, files, store } = fixture(); await store.init();
  const a = newSession(); a.history.push({ role: "user", content: "共同问题" }); await store.save(a);
  const other = open(adapter, "device-b"); await other.init();
  const b = await other.get(a.id);
  a.history.push({ role: "assistant", content: "设备 A 的回答" });
  b.history.push({ role: "assistant", content: "设备 B 的回答" });
  let arrivals = 0, resume!: () => void;
  const both = new Promise<void>(resolve => { resume = resolve; });
  const primary = `${DIR}/${a.id}.json`;
  adapter.write.mockImplementation(async (p, text) => {
    if (p === primary) { if (++arrivals === 2) resume(); await both; }
    files.set(p, text);
  });
  await Promise.all([store.save(a), other.save(b)]);
  adapter.write.mockImplementation(async (p, text) => { files.set(p, text); });
  // 两台设备各自重启，各自只检查自己写下的快照。
  const restartedA = open(adapter, "device-a"); await restartedA.init();
  const restartedB = open(adapter, "device-b"); await restartedB.init();
  const reader = open(adapter, "device-c"); await reader.init();
  const histories = await Promise.all(reader.list().map(async info => conversationMarkdown(await reader.get(info.id))));
  expect(histories.filter(text => text.includes("设备 A 的回答"))).toHaveLength(1);
  expect(histories.filter(text => text.includes("设备 B 的回答"))).toHaveLength(1);
  expect([...restartedA.warnings, ...restartedB.warnings].some(text => text.includes("恢复副本"))).toBe(true);
});

test("主文件尚未写入时中断，同一设备重启后补写回原会话", async () => {
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
  const reloaded = open(adapter, "device-a"); await reloaded.init();
  expect((await reloaded.get(session.id)).composer).toBe("尚未写进主文件的草稿");
  expect(reloaded.list()).toHaveLength(1);
  expect(reloaded.warnings).toEqual([]);
});

test("另一台设备的快照先于主文件同步到达时，不生成重复副本", async () => {
  const { adapter, files, store } = fixture(); await store.init();
  const session = newSession(); session.history.push({ role: "user", content: "Q1" }); await store.save(session);
  const main = `${DIR}/${session.id}.json`, older = files.get(main)!;
  session.composer = "桌面草稿"; await store.save(session);
  const newer = files.get(main)!;
  files.set(main, older);
  const phone = open(adapter, "device-b"); await phone.init();
  files.set(main, newer);
  const phoneAgain = open(adapter, "device-b"); await phoneAgain.init();
  expect([phone.list().length, phoneAgain.list().length]).toEqual([1, 1]);
  expect([...phone.warnings, ...phoneAgain.warnings]).toEqual([]);
  expect((await phoneAgain.get(session.id)).composer).toBe("桌面草稿");
});

test("另一台设备改过草稿后，原设备重启不生成恢复副本，旧快照被清理", async () => {
  const { adapter, files, store } = fixture(); await store.init();
  const session = newSession(); session.composer = "桌面草稿"; await store.save(session);
  const snapshot = `${DIR}/recovery/${session.id}.device-a.json`;
  expect(files.has(snapshot)).toBe(true);
  const phone = open(adapter, "device-b"); await phone.init();
  const onPhone = await phone.get(session.id); onPhone.composer = "桌面草稿，手机上改过"; await phone.save(onPhone);
  const desktop = open(adapter, "device-a"); await desktop.init();
  expect(desktop.list()).toHaveLength(1);
  expect(desktop.warnings).toEqual([]);
  expect(files.has(snapshot)).toBe(false);
});

test("与主文件一致的本机快照超过保留期后清理", async () => {
  const { adapter, files, store } = fixture(); await store.init();
  const old = newSession(); old.updatedAt = Date.now() - 15 * 24 * 3600 * 1000; await store.save(old);
  const fresh = newSession(); await store.save(fresh);
  const restarted = open(adapter, "device-a"); await restarted.init();
  expect(files.has(`${DIR}/recovery/${old.id}.device-a.json`)).toBe(false);
  expect(files.has(`${DIR}/recovery/${fresh.id}.device-a.json`)).toBe(true);
});

test("另一台设备仍是 0.6.2 时，重启后不用本机旧快照覆盖它写入的新回答", async () => {
  const { adapter, files, store } = fixture(); await store.init();
  const session = newSession(); session.history.push({ role: "user", content: "Q1" }); await store.save(session);
  const main = `${DIR}/${session.id}.json`;
  // 0.6.2 的设备在这份会话上追加回答，写回的文件没有版本向量。
  const { clock: _clock, ...legacy } = JSON.parse(files.get(main)!);
  legacy.history.push({ role: "assistant", content: "0.6.2 设备的回答" });
  files.set(main, JSON.stringify(legacy));
  const restarted = open(adapter, "device-a"); await restarted.init();
  expect((await restarted.get(session.id)).history.at(-1)?.content).toBe("0.6.2 设备的回答");
  expect(restarted.list()).toHaveLength(1);
  expect(restarted.warnings).toEqual([]);
});

test("0.6.2 留下的快照按原规则处理一次", async () => {
  const { adapter, files, store } = fixture(); await store.init();
  const kept = newSession(); kept.history.push({ role: "user", content: "已写入的问题" }); await store.save(kept);
  const lost = { ...kept, history: [...kept.history, { role: "assistant", content: "主文件里没有的回答" }] };
  // 0.6.2 的快照没有版本向量，文件名里的写入方是当时的运行标识。
  files.set(`${DIR}/recovery/${kept.id}.chat-old-run1.json`, JSON.stringify(kept));
  files.set(`${DIR}/recovery/${kept.id}.chat-old-run2.json`, JSON.stringify(lost));
  const restarted = open(adapter, "device-b"); await restarted.init();
  expect(files.has(`${DIR}/recovery/${kept.id}.chat-old-run1.json`)).toBe(false);
  expect(files.has(`${DIR}/recovery/${kept.id}.chat-old-run2.json`)).toBe(false);
  const all = await Promise.all(restarted.list().map(info => restarted.get(info.id)));
  expect(all).toHaveLength(2);
  expect(all.some(s => s.title.includes("恢复副本") && s.history.at(-1)?.content === "主文件里没有的回答")).toBe(true);
});

test("会话目录合并保留另一端新增的会话，并可刷新发现它", async () => {
  const { adapter, store } = fixture(); await store.init();
  const other = open(adapter, "device-b"); await other.init();
  const a = newSession(), b = newSession(); await store.save(a); await other.save(b);
  await store.refresh();
  expect(store.list().map(info => info.id)).toEqual(expect.arrayContaining([a.id, b.id]));
});

test("外部改动或删除之后不覆盖或复活原会话", async () => {
  const { files, store } = fixture(); await store.init();
  const session = newSession(); await store.save(session); const originalId = session.id;
  files.delete(`${DIR}/${originalId}.json`);
  session.composer = "本地仍有草稿";
  await store.save(session);
  expect(session.id).not.toBe(originalId);
  expect(files.has(`${DIR}/${originalId}.json`)).toBe(false);
  const changed = { ...session, history: [{ role: "user", content: "外部修改" }] };
  files.set(`${DIR}/${session.id}.json`, JSON.stringify(changed));
  await expect(store.delete(session.id)).rejects.toThrow("其它设备更新");
  expect(files.has(`${DIR}/${session.id}.json`)).toBe(true);
});
