import { extractMermaid } from "./mermaid";

test("提取显式 ```mermaid 块", () => {
  const out = extractMermaid("前言\n```mermaid\ngraph TD\nA-->B\n```\n后语");
  expect(out).toBe("```mermaid\ngraph TD\nA-->B\n```");
});

test("无 mermaid 标签但块内是图定义，也能识别并补标签", () => {
  const out = extractMermaid("```\nflowchart LR\nA-->B\n```");
  expect(out).toBe("```mermaid\nflowchart LR\nA-->B\n```");
});

test("裸图定义（无围栏）包成 mermaid 块", () => {
  expect(extractMermaid("graph TD\nA-->B")).toBe("```mermaid\ngraph TD\nA-->B\n```");
});

test("含散文前缀的输出不被整段误包（旧实现会，现应返回 null）", () => {
  expect(extractMermaid("这是你要的概念图：\ngraph TD\nA-->B")).toBeNull();
});

test("纯散文返回 null", () => {
  expect(extractMermaid("我们来聊聊 A 和 B 的区别。")).toBeNull();
});
