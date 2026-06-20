import { requestUrl } from "obsidian";
import { withTimeout } from "../util/withTimeout";
import type { CobrainSettings } from "../settings";

// 出图超时 180s：实测一张约 1 分钟，留足余量（requestUrl 不可中止，超时仅解锁 UI）
const IMAGE_TIMEOUT_MS = 180_000;

// gpt-image-2 出图（OpenAI 兼容 /images/generations）。实测返回 b64_json，约 1 分钟一张，故仅显式触发。
// 持有 settings 引用，调用时读最新 baseUrl/key/model 与 size/quality。
export class ImageClient {
  constructor(private settings: CobrainSettings) {}

  async generate(prompt: string): Promise<ArrayBuffer> {
    const url = `${this.settings.imageBaseUrl.replace(/\/+$/, "")}/images/generations`;
    const body: Record<string, unknown> = {
      model: this.settings.imageModel,
      prompt,
      n: 1,
      size: this.settings.imageSize || "1024x1024",
    };
    // 质量留空则不发送：部分代理不认未知参数会整请求 400，宁可不传也别打挂能用的出图
    if (this.settings.imageQuality) body.quality = this.settings.imageQuality;

    const res = await withTimeout(
      requestUrl({
        url,
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.settings.imageKey}` },
        body: JSON.stringify(body),
        throw: false,
      }),
      IMAGE_TIMEOUT_MS,
      "图像 API",
    );
    if (res.status !== 200) {
      throw new Error(`图像 API ${res.status}：${(res.text || "").slice(0, 200)}`);
    }
    const json: unknown = res.json;
    const item = json && typeof json === "object" && "data" in json && Array.isArray(json.data) ? json.data[0] : undefined;
    if (item && typeof item === "object") {
      if ("b64_json" in item && typeof item.b64_json === "string") {
        return base64ToArrayBuffer(item.b64_json);
      }
      if ("url" in item && typeof item.url === "string") {
        const img = await withTimeout(requestUrl({ url: item.url, throw: false }), IMAGE_TIMEOUT_MS, "下载图片");
        if (img.status === 200) return img.arrayBuffer;
      }
    }
    throw new Error("图像 API 未返回图片数据");
  }
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
