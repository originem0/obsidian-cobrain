import type { Embedder } from "./embedder";
import { VectorStore, type QueryHit } from "./vectorStore";
import type { CobrainSettings } from "../settings";

export class Retriever {
  // ready：检索前先 await 它，确保索引后台加载完成（见 main.ts 的 indexReady）。
  constructor(
    private embedder: Embedder,
    private store: VectorStore,
    private settings: Pick<CobrainSettings, "retrievalMinScore">,
    private ready?: () => Promise<void>,
  ) {}

  async retrieve(query: string, k = 8): Promise<QueryHit[]> {
    if (this.ready) await this.ready();
    const qv = await this.embedder.embedQuery(query);
    return await this.store.query(qv, k, this.settings.retrievalMinScore);
  }
}
