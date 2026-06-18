export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export interface Scored { id: string; score: number; }

// 约定：所有向量已 L2 归一化，故点积 == cosine 相似度
export function topK(
  query: number[],
  items: { id: string; vector: number[] }[],
  k: number
): Scored[] {
  return items
    .map(it => ({ id: it.id, score: dot(query, it.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
