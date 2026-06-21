jest.mock("obsidian", () => ({
  requestUrl: jest.fn(),
}), { virtual: true });

import { parseEmbeddingResponse } from "./apiEmbedder";

test("parseEmbeddingResponse 按 index 排序并归一化", () => {
  const out = parseEmbeddingResponse({
    data: [
      { index: 1, embedding: [0, 3, 4] },
      { index: 0, embedding: [3, 4, 0] },
    ],
  }, 2);

  expect(out).toHaveLength(2);
  expect(out[0][0]).toBeCloseTo(0.6);
  expect(out[0][1]).toBeCloseTo(0.8);
  expect(out[1][1]).toBeCloseTo(0.6);
  expect(out[1][2]).toBeCloseTo(0.8);
});

test.each([
  ["缺项", { data: [{ index: 0, embedding: [1, 0] }] }, 2],
  ["乱序缺 index", { data: [{ index: 1, embedding: [1, 0] }, { index: 2, embedding: [1, 0] }] }, 2],
  ["重复 index", { data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }] }, 2],
  ["维度不一致", { data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0] }] }, 2],
  ["NaN", { data: [{ index: 0, embedding: [Number.NaN] }] }, 1],
])("parseEmbeddingResponse 拒绝异常返回：%s", (_name, payload, count) => {
  expect(() => parseEmbeddingResponse(payload, count)).toThrow();
});
