import { quantizeVector, dequantizeVector, quantizeToBytes, dotQuantized } from "./quantize";

function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / n);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

test("量化往返后 cosine 几乎不变（>0.999）", () => {
  const dim = 256;
  // 用确定性函数造向量，避免 Math.random 的不确定性
  const v = normalize(Array.from({ length: dim }, (_, i) => Math.sin(i * 0.7) + Math.cos(i * 0.13)));
  const { scale, q } = quantizeVector(v);
  const back = dequantizeVector(scale, q);
  expect(back.length).toBe(dim);
  expect(cosine(v, back)).toBeGreaterThan(0.999);
});

test("零向量量化不产生 NaN", () => {
  const v = new Array(16).fill(0);
  const { scale, q } = quantizeVector(v);
  expect(scale).toBe(0);
  const back = dequantizeVector(scale, q);
  expect(back).toEqual(new Array(16).fill(0));
  expect(back.some(Number.isNaN)).toBe(false);
});

test("含负值往返：每维误差不超过量化步长", () => {
  const v = normalize([-1, -0.5, 0, 0.5, 1, -0.9, 0.3]);
  const { scale, q } = quantizeVector(v);
  const back = dequantizeVector(scale, q);
  expect(back.length).toBe(v.length);
  for (let i = 0; i < v.length; i++) {
    expect(Math.abs(back[i] - v[i])).toBeLessThanOrEqual(scale / 127 + 1e-9);
  }
});

test("dotQuantized 与「反量化后再点积」数值等价（评分语义不变）", () => {
  const a = normalize(Array.from({ length: 64 }, (_, i) => Math.sin(i)));
  const query = normalize(Array.from({ length: 64 }, (_, i) => Math.cos(i * 0.3)));
  const { scale, bytes } = quantizeToBytes(a);

  const fast = dotQuantized(query, bytes, scale);
  const back = dequantizeVector(scale, quantizeVector(a).q);
  const slow = query.reduce((s, x, i) => s + x * back[i], 0);

  expect(fast).toBeCloseTo(slow, 8);
});

test("dotQuantized 对零向量返回 0", () => {
  expect(dotQuantized([1, 2, 3], new Int8Array([0, 0, 0]), 0)).toBe(0);
});
