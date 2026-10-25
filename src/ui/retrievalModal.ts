import { App, Modal, Notice } from "obsidian";
import type CobrainPlugin from "../main";
import type { MaterialReference } from "../chat/session";
import type { QueryHit } from "../rag/vectorStore";
import { parseFolders } from "../rag/scope";

export class RetrievalModal extends Modal {
  private generation = 0;
  constructor(app: App, private plugin: CobrainPlugin, private attach?: (materials: MaterialReference[]) => void) { super(app); }
  onOpen(): void {
    const root = this.contentEl;
    root.addClass("cobrain-retrieval-modal");
    root.createEl("h3", { text: "手动查找其它资料" });
    root.createEl("p", { text: "搜索不会自动把结果交给模型。选中并添加后，文档才会进入当前会话。", cls: "cobrain-muted" });
    const modeLabel = root.createEl("label", { cls: "cobrain-field-label", text: "搜索范围" });
    const mode = modeLabel.createEl("select");
    mode.createEl("option", { value: "folders", text: "指定目录" });
    mode.createEl("option", { value: "vault", text: "全部允许索引的范围" });
    const folders = root.createEl("input", { type: "text", cls: "cobrain-modal-input" });
    folders.setAttribute("aria-label", "要搜索的目录，逗号分隔");
    folders.placeholder = "要搜索的目录，逗号分隔…";
    const current = this.plugin.currentDocument()?.parent?.path;
    folders.value = current && current !== "/" ? current : parseFolders(this.plugin.settings.indexIncludeFolders).find(f => f !== ".") ?? "";
    mode.onchange = () => { folders.disabled = mode.value === "vault"; };
    const query = root.createEl("input", { type: "search", cls: "cobrain-modal-input" });
    query.setAttribute("aria-label", "要查找的问题或关键词");
    query.placeholder = "问题或关键词…";
    const status = root.createDiv({ cls: "cobrain-muted", attr: { "aria-live": "polite" } });
    const search = root.createEl("button", { text: "搜索", cls: "mod-cta" });
    const results = root.createDiv({ cls: "cobrain-search-results" });
    const selected = new Set<string>();
    const add = this.attach ? root.createEl("button", { text: "添加所选文档", cls: "mod-cta" }) : null;
    if (add) {
      add.disabled = true;
      add.onclick = () => {
        this.attach?.([...selected].map(path => ({ id: `document:${path}`, path, kind: "document", origin: "unknown" })));
        this.close(); new Notice(`已添加 ${selected.size} 篇文档`);
      };
    }
    const draw = (hits: QueryHit[]) => {
      results.empty();
      for (const hit of hits) {
        const row = results.createEl("label", { cls: "cobrain-search-result" });
        if (this.attach) {
          const check = row.createEl("input", { type: "checkbox" });
          check.onchange = () => {
            check.checked ? selected.add(hit.path) : selected.delete(hit.path);
            if (add) { add.disabled = !selected.size; add.setText(`添加所选文档${selected.size ? `（${selected.size}）` : ""}`); }
          };
        }
        const info = row.createDiv();
        info.createDiv({ text: hit.path.replace(/\.md$/i, ""), cls: "cobrain-search-title" });
        info.createDiv({ text: hit.text.slice(0, 180), cls: "cobrain-muted" });
      }
    };
    const run = async () => {
      const text = query.value.trim();
      if (!text) { query.focus(); return; }
      const scope = mode.value === "vault" ? { mode: "vault" as const } : { mode: "folders" as const, folders: parseFolders(folders.value) };
      if (scope.mode === "folders" && !scope.folders?.length) { status.setText("请明确填写搜索目录。"); return; }
      const gen = ++this.generation;
      search.disabled = true; status.setText("正在搜索…"); selected.clear();
      if (add) add.disabled = true;
      results.empty();
      try {
        const hits = await this.plugin.searchNotes(text, scope);
        if (gen !== this.generation) return;
        draw(hits); status.setText(hits.length ? `找到 ${hits.length} 篇，仅供选择。` : "在指定范围内没有找到相关材料。可直接添加文档。 ");
      } catch (e) {
        if (gen === this.generation) status.setText(e instanceof Error ? e.message : String(e));
      } finally { if (gen === this.generation) search.disabled = false; }
    };
    search.onclick = () => void run();
    query.onkeydown = e => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) void run(); };
  }
  onClose(): void { this.generation++; this.contentEl.empty(); }
}
