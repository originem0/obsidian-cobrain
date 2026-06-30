jest.mock("obsidian", () => ({
  requestUrl: jest.fn(),
}), { virtual: true });

import { parseChatResponse } from "./chatClient";

test("parseChatResponse 取 choices[0].message.content", () => {
  expect(parseChatResponse({ choices: [{ message: { content: "回答" } }] })).toBe("回答");
});

test.each([
  ["空对象", {}],
  ["choices 非数组", { choices: {} }],
  ["choices 为空", { choices: [] }],
  ["缺 message", { choices: [{}] }],
  ["content 非字符串", { choices: [{ message: { content: 1 } }] }],
  ["content 仅空白", { choices: [{ message: { content: "  \n " } }] }],
])("parseChatResponse 拒绝异常/空返回：%s", (_name, payload) => {
  expect(() => parseChatResponse(payload)).toThrow();
});
