import { dot, topK } from "./vectorMath";

test("dot 计算点积", () => {
  expect(dot([1, 0, 1], [1, 2, 3])).toBe(4);
});

test("topK 按点积降序取前 k", () => {
  const items = [
    { id: "a", vector: [1, 0] },
    { id: "b", vector: [0, 1] },
    { id: "c", vector: [0.9, 0.1] },
  ];
  const res = topK([1, 0], items, 2);
  expect(res.map(r => r.id)).toEqual(["a", "c"]);
  expect(res[0].score).toBeCloseTo(1);
});
