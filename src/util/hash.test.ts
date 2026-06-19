import { fnv1a, fnv1a64 } from "./hash";

test("fnv1a 确定性：同输入同输出", () => {
  expect(fnv1a("hello 世界")).toBe(fnv1a("hello 世界"));
});

test("fnv1a 不同输入不同输出", () => {
  expect(fnv1a("a")).not.toBe(fnv1a("b"));
  expect(fnv1a("内容 v1")).not.toBe(fnv1a("内容 v2"));
});

test("fnv1a 返回非空十六进制串", () => {
  expect(fnv1a("x")).toMatch(/^[0-9a-f]+$/);
});

test("fnv1a64 确定性 + 定长 16-hex", () => {
  const h = fnv1a64("Explore/哲学/存在主义.md");
  expect(h).toBe(fnv1a64("Explore/哲学/存在主义.md"));
  expect(h).toMatch(/^[0-9a-f]{16}$/);
});

test("fnv1a64 不同输入不同（含同长度）", () => {
  expect(fnv1a64("a.md")).not.toBe(fnv1a64("b.md"));
  expect(fnv1a64("note1.md")).not.toBe(fnv1a64("note2.md"));
});
