import { requestUrl } from "obsidian";

// gpt-image-2 出图（OpenAI 兼容 /images/generations）。实测返回 b64_json，约 1 分钟一张，故仅显式触发。
export class ImageClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
  ) {}

  async generate(prompt: string, size = "1024x1024"): Promise<ArrayBuffer> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/images/generations`;
    const res = await requestUrl({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, prompt, n: 1, size }),
      throw: false,
    });
    if (res.status !== 200) {
      throw new Error(`图像 API ${res.status}：${(res.text || "").slice(0, 200)}`);
    }
    const item = res.json?.data?.[0];
    if (item?.b64_json) return base64ToArrayBuffer(item.b64_json);
    if (item?.url) {
      const img = await requestUrl({ url: item.url, throw: false });
      if (img.status === 200) return img.arrayBuffer;
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
