import { SseLineBuffer, extractStreamDelta } from "./sse";

test("SseLineBuffer 按行取 data 载荷，跨块断行能拼接", () => {
  const buf = new SseLineBuffer();

  expect(buf.feed('data: {"a"')).toEqual([]); // 半行留缓冲
  expect(buf.feed(':1}\ndata: {"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
});

test("SseLineBuffer 兼容 \\r\\n，忽略 event/注释/空行", () => {
  const buf = new SseLineBuffer();

  const out = buf.feed('event: message\r\ndata: {"a":1}\r\n: keep-alive\r\n\r\ndata: [DONE]\n');

  expect(out).toEqual(['{"a":1}', "[DONE]"]);
});

test("SseLineBuffer flush 吐出流末尾没带换行的残行", () => {
  const buf = new SseLineBuffer();

  expect(buf.feed("data: [DONE]")).toEqual([]);
  expect(buf.flush()).toEqual(["[DONE]"]);
  expect(buf.flush()).toEqual([]); // 二次 flush 为空
});

test("extractStreamDelta 取 choices[0].delta.content", () => {
  expect(extractStreamDelta({ choices: [{ delta: { content: "增量" } }] })).toBe("增量");
});

test.each([
  ["usage 尾包（无 choices）", { usage: { total_tokens: 10 } }],
  ["choices 为空", { choices: [] }],
  ["delta 缺 content", { choices: [{ delta: {} }] }],
  ["reasoning-only 增量", { choices: [{ delta: { reasoning_content: "思考" } }] }],
  ["content 非字符串", { choices: [{ delta: { content: 1 } }] }],
  ["非对象", "oops"],
])("extractStreamDelta 对非内容块返回空串：%s", (_name, payload) => {
  expect(extractStreamDelta(payload)).toBe("");
});
