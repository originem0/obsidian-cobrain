jest.mock("obsidian", () => ({
  requestUrl: jest.fn(),
}), { virtual: true });

import { requestUrl } from "obsidian";
import { ChatClient, parseChatResponse } from "./chatClient";
import type { CobrainSettings } from "../settings";
import type { ChatMsg } from "./chatClient";

const settings = { llmBaseUrl: "https://chat.example/v1", llmKey: "k", llmModel: "m" } as CobrainSettings;
const msgs: ChatMsg[] = [{ role: "user", content: "hi" }];

// 最小 fetch Response 桩：只实现 chatClient 用到的面（status/headers/body/json/text）
function sseResponse(chunks: string[]): unknown {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: encoder.encode(chunks[i++]) }
            : { done: true, value: undefined },
      }),
    },
  };
}

function jsonResponse(payload: unknown, status = 200): unknown {
  return {
    status,
    headers: { get: () => "application/json" },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

beforeEach(() => {
  (requestUrl as jest.Mock).mockReset();
});

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

test("流式：SSE 增量依次回调 onDelta，最终整段返回", async () => {
  const fetchImpl = jest.fn(async () => sseResponse([
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n',
  ]));
  const client = new ChatClient(settings, fetchImpl as unknown as typeof fetch);
  const deltas: string[] = [];

  const out = await client.chat(msgs, { onDelta: t => deltas.push(t) });

  expect(out).toBe("你好");
  expect(deltas).toEqual(["你", "好"]);
  expect(JSON.parse((fetchImpl.mock.calls[0] as any)[1].body).stream).toBe(true);
  expect(requestUrl).not.toHaveBeenCalled();
});

test("流式：端点静默忽略 stream 参数（回普通 JSON）时按非流式整段解析", async () => {
  const fetchImpl = jest.fn(async () => jsonResponse({ choices: [{ message: { content: "整段" } }] }));
  const client = new ChatClient(settings, fetchImpl as unknown as typeof fetch);
  const deltas: string[] = [];

  const out = await client.chat(msgs, { onDelta: t => deltas.push(t) });

  expect(out).toBe("整段");
  expect(deltas).toEqual([]);
});

test("流式：端点对 stream 参数报 4xx 时自动降级非流式再试一次", async () => {
  const fetchImpl = jest.fn()
    .mockResolvedValueOnce(jsonResponse({ error: "stream unsupported" }, 400))
    .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "降级成功" } }] }));
  const client = new ChatClient(settings, fetchImpl as unknown as typeof fetch);

  const out = await client.chat(msgs, { onDelta: () => undefined });

  expect(out).toBe("降级成功");
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(JSON.parse((fetchImpl.mock.calls[1] as any)[1].body).stream).toBeUndefined();
  expect(requestUrl).not.toHaveBeenCalled();
});

test("非流式 HTTP 错误直接抛出，不回退 requestUrl（端点已应答，换传输重试无意义）", async () => {
  const fetchImpl = jest.fn(async () => jsonResponse({ error: "boom" }, 500));
  const client = new ChatClient(settings, fetchImpl as unknown as typeof fetch);

  await expect(client.chat(msgs)).rejects.toThrow("聊天 API 500");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(requestUrl).not.toHaveBeenCalled();
});

test("网络层失败（TypeError，典型是无 CORS 头）回退 requestUrl 非流式", async () => {
  (requestUrl as jest.Mock).mockResolvedValue({
    status: 200,
    json: { choices: [{ message: { content: "兜底成功" } }] },
  });
  const fetchImpl = jest.fn(async () => { throw new TypeError("Failed to fetch"); });
  const client = new ChatClient(settings, fetchImpl as unknown as typeof fetch);

  const out = await client.chat(msgs);

  expect(out).toBe("兜底成功");
  expect(requestUrl).toHaveBeenCalledTimes(1);
});

test("用户已中止（signal aborted）不回退 requestUrl——停止就是停止", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const fetchImpl = jest.fn(async () => { throw new TypeError("aborted"); });
  const client = new ChatClient(settings, fetchImpl as unknown as typeof fetch);

  await expect(client.chat(msgs, { signal: ctrl.signal })).rejects.toThrow();
  expect(requestUrl).not.toHaveBeenCalled();
});

test("已吐出增量后中途断流不回退（回退重跑会让消费方拿到重复内容）", async () => {
  const encoder = new TextEncoder();
  const read = jest.fn()
    .mockResolvedValueOnce({ done: false, value: encoder.encode('data: {"choices":[{"delta":{"content":"半"}}]}\n\n') })
    .mockRejectedValueOnce(new TypeError("network reset"));
  const fetchImpl = jest.fn(async () => ({
    status: 200,
    headers: { get: () => "text/event-stream" },
    body: { getReader: () => ({ read }) },
  }));
  const client = new ChatClient(settings, fetchImpl as unknown as typeof fetch);
  const deltas: string[] = [];

  await expect(client.chat(msgs, { onDelta: t => deltas.push(t) })).rejects.toThrow();
  expect(deltas).toEqual(["半"]);
  expect(requestUrl).not.toHaveBeenCalled();
});

test("流跑完但没有任何内容按空内容报错", async () => {
  const fetchImpl = jest.fn(async () => sseResponse(["data: [DONE]\n\n"]));
  const client = new ChatClient(settings, fetchImpl as unknown as typeof fetch);

  await expect(client.chat(msgs, { onDelta: () => undefined })).rejects.toThrow("聊天 API 返回空内容");
  expect(requestUrl).not.toHaveBeenCalled();
});
