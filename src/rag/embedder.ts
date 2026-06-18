export interface Embedder {
  // 文档侧批量嵌入（实现内部按需加 "passage: " 前缀）
  embedDocuments(texts: string[]): Promise<number[][]>;
  // 查询侧（按需加 "query: " 前缀）
  embedQuery(text: string): Promise<number[]>;
  readonly dim: number | null;
}
