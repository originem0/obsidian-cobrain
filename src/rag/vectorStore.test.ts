import { VectorStore } from "./vectorStore";

test("增删查与序列化", () => {
  const s = new VectorStore();
  s.setFile("a.md", 100, [
    { text: "猫", heading: "", vector: [1, 0] },
    { text: "狗", heading: "", vector: [0.8, 0.2] },
  ]);
  s.setFile("b.md", 100, [{ text: "汽车", heading: "", vector: [0, 1] }]);

  const hits = s.query([1, 0], 2);
  expect(hits[0].path).toBe("a.md");
  expect(hits.length).toBe(2);

  // 重设同一文件应替换旧块
  s.setFile("a.md", 200, [{ text: "鱼", heading: "", vector: [0, 1] }]);
  expect(s.query([1, 0], 5).filter(h => h.path === "a.md").length).toBe(1);

  // 序列化往返
  const json = s.serialize();
  const s2 = new VectorStore();
  s2.deserialize(json);
  expect(s2.query([0, 1], 1)[0].text).toBeDefined();

  // mtime 查询
  expect(s.getMtime("a.md")).toBe(200);
  s.removeFile("a.md");
  expect(s.getMtime("a.md")).toBeNull();
});
