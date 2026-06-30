import { VectorStore } from "./vectorStore";

test("增删查与序列化", async () => {
  const s = new VectorStore();
  s.setFile("a.md", 100, [
    { text: "猫", heading: "", vector: [1, 0] },
    { text: "狗", heading: "", vector: [0.8, 0.2] },
  ]);
  s.setFile("b.md", 100, [{ text: "汽车", heading: "", vector: [0, 1] }]);

  const hits = await s.query([1, 0], 2);
  expect(hits[0].path).toBe("a.md");
  expect(hits.length).toBe(2);

  // 重设同一文件应替换旧块
  s.setFile("a.md", 200, [{ text: "鱼", heading: "", vector: [0, 1] }]);
  expect((await s.query([1, 0], 5)).filter(h => h.path === "a.md").length).toBe(1);

  // 序列化往返
  const json = s.serialize();
  const s2 = new VectorStore();
  s2.deserialize(json);
  expect((await s2.query([0, 1], 1))[0].text).toBeDefined();

  // mtime 查询
  expect(s.getMtime("a.md")).toBe(200);
  s.removeFile("a.md");
  expect(s.getMtime("a.md")).toBeNull();
});

test("hash 存取、setMtime 与 removeFile 清理 + 序列化往返", () => {
  const s = new VectorStore();
  s.setFile("a.md", 100, [{ text: "x", heading: "", vector: [1, 0] }]);
  s.setHash("a.md", "deadbeef");
  expect(s.getHash("a.md")).toBe("deadbeef");
  expect(s.getHash("missing.md")).toBeNull();

  // setMtime 只更新时间戳
  s.setMtime("a.md", 999);
  expect(s.getMtime("a.md")).toBe(999);

  // 序列化往返保留 hashes
  const s2 = new VectorStore();
  s2.deserialize(s.serialize());
  expect(s2.getHash("a.md")).toBe("deadbeef");

  // removeFile 同时清掉 hash
  s.removeFile("a.md");
  expect(s.getHash("a.md")).toBeNull();
});

test("serialize 输出 int8 量化格式（v2，entry 含 q 不含 vector）", () => {
  const s = new VectorStore();
  s.setFile("a.md", 1, [{ text: "x", heading: "", vector: [0.6, 0.8] }]);
  const out = s.serialize() as any;
  expect(out.v).toBe(2);
  expect(typeof out.entries[0].q).toBe("string");
  expect(typeof out.entries[0].scale).toBe("number");
  expect(out.entries[0].vector).toBeUndefined();
});

test("量化序列化往返：top-1 命中不变", async () => {
  const s = new VectorStore();
  s.setFile("a.md", 1, [
    { text: "猫", heading: "", vector: [0.6, 0.8] },
    { text: "狗", heading: "", vector: [0.8, 0.6] },
  ]);
  s.setFile("b.md", 1, [{ text: "车", heading: "", vector: [-0.7, 0.71] }]);
  const before = (await s.query([0.6, 0.8], 1))[0];
  const s2 = new VectorStore();
  s2.deserialize(s.serialize());
  const after = (await s2.query([0.6, 0.8], 1))[0];
  expect(after.path).toBe(before.path);
  expect(after.text).toBe(before.text);
});

test("兼容旧 float64 格式（entry 带 vector 数组、无 q）", async () => {
  const s = new VectorStore();
  s.deserialize({
    entries: [{ path: "a.md", chunkIdx: 0, text: "猫", heading: "", vector: [1, 0] }],
    mtimes: { "a.md": 1 },
    hashes: {},
  });
  const hits = await s.query([1, 0], 1);
  expect(hits[0].text).toBe("猫");
});

test("serializeFile 取单篇（量化、不含其它笔记、无则 null）", () => {
  const s = new VectorStore();
  s.setFile("a.md", 1, [{ text: "猫", heading: "", vector: [0.6, 0.8] }]);
  s.setHash("a.md", "h1");
  s.setFile("b.md", 2, [{ text: "狗", heading: "", vector: [0.8, 0.6] }]);
  const sf = s.serializeFile("a.md")!;
  expect(sf.path).toBe("a.md");
  expect(sf.mtime).toBe(1);
  expect(sf.hash).toBe("h1");
  expect(sf.entries.length).toBe(1);
  expect(typeof sf.entries[0].q).toBe("string");
  expect((sf.entries[0] as any).path).toBeUndefined();
  expect(s.serializeFile("missing.md")).toBeNull();
});

test("serializeFile→deserializeFile 往返：命中与 mtime 保留", async () => {
  const s = new VectorStore();
  s.setFile("a.md", 7, [{ text: "猫", heading: "H", vector: [0.6, 0.8] }]);
  const s2 = new VectorStore();
  s2.deserializeFile(s.serializeFile("a.md")!);
  const hit = (await s2.query([0.6, 0.8], 1))[0];
  expect(hit.text).toBe("猫");
  expect(hit.heading).toBe("H");
  expect(s2.getMtime("a.md")).toBe(7);
});

test("query 按笔记去重：同一篇的多个 chunk 只占一个名额，给别的笔记腾位", async () => {
  const s = new VectorStore();
  // a.md 有两个高分 chunk；b.md、c.md 各一个略低分
  s.setFile("a.md", 1, [
    { text: "a1", heading: "", vector: [1, 0] },       // 与 [1,0] 点积 1.0
    { text: "a2", heading: "", vector: [0.99, 0.01] }, // ~0.99
  ]);
  s.setFile("b.md", 1, [{ text: "b1", heading: "", vector: [0.9, 0.1] }]); // ~0.9
  s.setFile("c.md", 1, [{ text: "c1", heading: "", vector: [0.8, 0.2] }]); // ~0.8

  const hits = await s.query([1, 0], 2);
  // 旧实现取 top-2 chunk 会返回 a1、a2（都是 a.md）；去重后应是 a.md、b.md
  expect(hits.map(h => h.path)).toEqual(["a.md", "b.md"]);
  // 每篇至多一个名额
  expect(new Set(hits.map(h => h.path)).size).toBe(hits.length);
  // 保留的是该篇分数最高的 chunk
  expect(hits[0].text).toBe("a1");
});

test("renameFile 把条目/mtime/hash 改键到新路径（不重嵌）", async () => {
  const s = new VectorStore();
  s.setFile("old.md", 5, [{ text: "猫", heading: "", vector: [1, 0] }]);
  s.setHash("old.md", "h");
  s.renameFile("old.md", "new.md");
  expect(s.getMtime("old.md")).toBeNull();
  expect(s.getHash("old.md")).toBeNull();
  expect(s.getMtime("new.md")).toBe(5);
  expect(s.getHash("new.md")).toBe("h");
  expect((await s.query([1, 0], 1))[0].path).toBe("new.md");
  expect(s.allPaths()).toEqual(["new.md"]);
});

test("query 按最低分过滤命中", async () => {
  const s = new VectorStore();
  s.setFile("a.md", 1, [{ text: "a", heading: "", vector: [1, 0] }]);
  s.setFile("b.md", 1, [{ text: "b", heading: "", vector: [0.1, 0.9] }]);

  const hits = await s.query([1, 0], 5, 0.2);
  expect(hits.map(h => h.path)).toEqual(["a.md"]);
});
