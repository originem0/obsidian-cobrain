import { fnv1a } from "./hash";

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
