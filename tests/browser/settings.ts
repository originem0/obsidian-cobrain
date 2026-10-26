import { CobrainSettingTab, DEFAULT_SETTINGS } from "../../src/settings";
import { Platform } from "obsidian";

const w = window as any;
let modal: HTMLElement;
let tab: CobrainSettingTab;
let plugin: any;
let embedResets = 0;

w.openSettingsTest = (constrained = false) => {
  modal?.remove();
  modal = document.body.createDiv({ cls: "cobrain-settings-test-host" });
  modal.createDiv({ cls: "settings-test-title", text: "Cobrain 设置" });
  const frame = modal.createDiv({ cls: "vertical-tab-content-container" });
  embedResets = 0;
  plugin = { settings: { ...DEFAULT_SETTINGS }, saveSettings: async () => undefined, saveSettingsDebounced: () => undefined,
    resetIndexForEmbedModelChange: async () => { embedResets++; }, reportError: (e: Error) => { throw e; } };
  tab = new CobrainSettingTab({} as any, plugin);
  frame.appendChild(tab.containerEl);
  // Include a host that clips content: the plugin must own its scroll region.
  modal.classList.toggle("constrained-settings", constrained);
  tab.display();
  tab.containerEl.querySelectorAll("details").forEach(el => { el.open = true; });
};
w.settingsLayout = () => {
  const scroller = tab.containerEl;
  const controls = [...scroller.querySelectorAll<HTMLElement>("textarea, button, input, select")];
  const view = scroller.getBoundingClientRect();
  const wheelMoved = scroller.scrollTop > 0;
  scroller.scrollTop = scroller.scrollHeight;
  const last = [...scroller.querySelectorAll<HTMLButtonElement>("button")].at(-1)!;
  const bottom = last.getBoundingClientRect();
  const topAfter = scroller.scrollTop;
  const overflowY = getComputedStyle(scroller).overflowY;
  const prompts = [...scroller.querySelectorAll<HTMLTextAreaElement>("textarea")].slice(-3);
  return {
    width: innerWidth, height: innerHeight, overflowY, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
    scrollTop: topAfter, wheelMoved, canScroll: /auto|scroll/.test(overflowY) && topAfter > 0,
    lastControlVisible: bottom.top >= view.top && bottom.bottom <= view.bottom,
    controlsFit: controls.every(el => { const r = el.getBoundingClientRect(); return r.left >= view.left && r.right <= view.right; }),
    promptWidths: prompts.map(el => el.getBoundingClientRect().width),
    openPanels: scroller.querySelectorAll("details[open]").length,
  };
};
w.settingsScrollTarget = () => {
  tab.containerEl.scrollTop = 0;
  const view = tab.containerEl.getBoundingClientRect();
  return { x: view.right - 8, y: view.top + 80 };
};
w.closeSettingsTest = () => modal.remove();

w.runSettingsTests = async () => {
  const previousMobile = Platform.isMobile;
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    Platform.isMobile = false;
    w.openSettingsTest();
    const chat = tab.containerEl.querySelector<HTMLInputElement>('input[name="cobrain-chat-model"]')!;
    chat.value = "custom-chat-model"; chat.dispatchEvent(new Event("input"));
    assert(plugin.settings.llmModel === "custom-chat-model", "New installation cannot type a model without detection");
    const choices = chat.closest(".setting-item")!.querySelector("select")!;
    assert(choices.value === "custom-chat-model", "Typed model is missing from choices");
    plugin.settings.llmBaseUrl = "test"; plugin.settings.llmKey = "test";
    (chat.closest(".setting-item")!.querySelector("button") as HTMLButtonElement).click();
    await tick();
    assert(plugin.settings.llmModel === "custom-chat-model" && choices.value === "custom-chat-model", "Failed model detection cleared the typed model");
    assert(tab.containerEl.textContent?.includes("明文保存在库内插件数据中"), "Key storage disclosure is missing");
    const embed = tab.containerEl.querySelector<HTMLInputElement>('input[name="cobrain-embed-model"]')!;
    embed.value = "custom-embed-model"; embed.dispatchEvent(new Event("input"));
    assert(embedResets === 0 && plugin.settings.embedModel === "", "Typing a partial embedding model resets the index");
    embed.dispatchEvent(new Event("change")); await tick();
    assert(embedResets === 1 && plugin.settings.embedModel === "custom-embed-model", "Embedding model edit was not committed once");
    Platform.isMobile = true; w.openSettingsTest();
    const mobileEmbed = tab.containerEl.querySelector<HTMLInputElement>('input[name="cobrain-embed-model"]')!;
    assert(mobileEmbed.disabled, "Mobile embedding settings are writable");
    mobileEmbed.value = "forbidden-model"; mobileEmbed.dispatchEvent(new Event("change")); await tick();
    assert(embedResets === 0 && plugin.settings.embedModel === "", "Mobile guard changed the embedding model");
    return ["manual model configuration survives failed detection", "embedding model commits once and is protected on mobile", "key storage disclosure"];
  } finally { w.closeSettingsTest(); Platform.isMobile = previousMobile; }
};
