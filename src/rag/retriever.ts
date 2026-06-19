import type { Embedder } from "./embedder";
import { VectorStore, type QueryHit } from "./vectorStore";

export class Retriever {
  constructor(private embedder: Embedder, private store: VectorStore) {}

  async retrieve(query: string, k = 8): Promise<QueryHit[]> {
    const qv = await this.embedder.embedQuery(query);
    return this.store.query(qv, k);
  }
}
