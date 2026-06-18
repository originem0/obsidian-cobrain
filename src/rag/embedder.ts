export interface Embedder {
  // 文档侧批量嵌入
  embedDocuments(texts: string[]): Promise<number[][]>;
  // 查询侧嵌入
  embedQuery(text: string): Promise<number[]>;
}
