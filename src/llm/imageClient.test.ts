jest.mock("obsidian", () => ({
  requestUrl: jest.fn(),
}), { virtual: true });

import { parseImageResponse } from "./imageClient";

test("parseImageResponse 取 b64_json", () => {
  expect(parseImageResponse({ data: [{ b64_json: "AAAA" }] })).toEqual({ b64: "AAAA" });
});

test("parseImageResponse 取 url（无 b64 时）", () => {
  expect(parseImageResponse({ data: [{ url: "https://x/y.png" }] })).toEqual({ url: "https://x/y.png" });
});

test.each([
  ["空对象", {}],
  ["data 非数组", { data: {} }],
  ["data 为空", { data: [] }],
  ["项无 b64/url", { data: [{ revised_prompt: "x" }] }],
])("parseImageResponse 拒绝无图返回：%s", (_name, payload) => {
  expect(() => parseImageResponse(payload)).toThrow();
});
