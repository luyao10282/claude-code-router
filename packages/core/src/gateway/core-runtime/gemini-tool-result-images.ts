import { isRecord } from "@ccr/core/gateway/internal/value";

type ToolResult = { content: unknown[] };
type ImagePart = { inlineData: { mimeType: string; data: string } };

export class GeminiToolResultImageError extends Error {}

/**
 * ai-gateway 1.0.21 normalizes Anthropic tool_result.content to a string:
 * image-only results become base64 JSON, while mixed text/image results lose
 * their images. Recover media from the original structured request, never by
 * interpreting arbitrary tool output as JSON. Keep each image inside its own
 * functionResponse, including historical and out-of-order parallel results.
 * Create a fresh restorer per request so retries cannot consume shared state.
 */
export function createGeminiToolResultImageRestorer(sourceBody: unknown): (part: unknown) => unknown {
  const resultsById = new Map<string, ToolResult[]>();
  if (isRecord(sourceBody) && Array.isArray(sourceBody.messages)) {
    for (const message of sourceBody.messages) {
      if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== "tool_result") continue;
        const id = block.tool_use_id;
        if (typeof id !== "string") continue;
        const results = resultsById.get(id) ?? [];
        results.push({ content: Array.isArray(block.content) ? block.content : [] });
        resultsById.set(id, results);
      }
    }
  }
  const positions = new Map<string, number>();

  return (part) => {
    if (!isRecord(part)) return part;
    const key = isRecord(part.functionResponse) ? "functionResponse" : "function_response";
    const response = part[key];
    if (!isRecord(response) || typeof response.id !== "string") return part;
    const position = positions.get(response.id) ?? 0;
    positions.set(response.id, position + 1);
    const source = resultsById.get(response.id)?.[position];
    if (!source) return part;
    const images = source.content.filter((block) => isRecord(block) && block.type === "image");
    if (images.length === 0) return part;

    const restoredImages = images.map((image) => imagePart(image, response.id as string));
    const existing = Array.isArray(response.parts) ? response.parts : [];
    const parts = [...existing];
    const matched = new Set<number>();
    for (const image of restoredImages) {
      const index = existing.findIndex((candidate, index) => !matched.has(index) && sameImage(candidate, image));
      if (index >= 0) matched.add(index);
      else parts.push(image);
    }

    const output = isRecord(response.response) ? response.response : {};
    const content = cleanSerializedImages(output.content, source.content);
    if (parts.length === existing.length && content === output.content) return part;
    return {
      ...part,
      [key]: { ...response, response: { ...output, content }, parts }
    };
  };
}

function imagePart(block: unknown, id: string): ImagePart {
  const source = isRecord(block) && isRecord(block.source) ? block.source : undefined;
  // FunctionResponsePart supports inlineData, not arbitrary remote URLs. Fail
  // explicitly rather than fetching URLs at the provider boundary or silently
  // passing image encodings as text.
  if (source?.type !== "base64" || typeof source.data !== "string" || !source.data ||
    typeof source.media_type !== "string" || !source.media_type.startsWith("image/")) {
    throw new GeminiToolResultImageError(`Cannot convert image in tool result ${id}: expected base64 image data and an image MIME type.`);
  }
  return { inlineData: { mimeType: source.media_type, data: source.data } };
}

function sameImage(candidate: unknown, expected: ImagePart): boolean {
  if (!isRecord(candidate)) return false;
  const data = isRecord(candidate.inlineData) ? candidate.inlineData : candidate.inline_data;
  return isRecord(data) && (data.mimeType ?? data.mime_type) === expected.inlineData.mimeType &&
    data.data === expected.inlineData.data;
}

function cleanSerializedImages(content: unknown, original: unknown[]): unknown {
  if (typeof content !== "string") return content;
  const before = legacyToolResultText(original);
  const after = legacyToolResultText(original.filter((block) => !isRecord(block) || block.type !== "image"));
  // Match only the known adapter output, retaining its appended tool-reference
  // suffix. Mixed text/image results already have clean text and need no edit.
  if (before !== after && (content === before || content.startsWith(`${before}\n`))) {
    return after + content.slice(before.length);
  }
  return content;
}

function legacyToolResultText(blocks: unknown[]): string {
  const residual = blocks.filter((block) => !isRecord(block) || block.type !== "tool_reference");
  const text = residual.map((block) => {
    if (typeof block === "string") return block.trim();
    if (!isRecord(block)) return "";
    for (const key of ["text", "input_text", "output_text"]) {
      if (typeof block[key] === "string") return block[key].trim();
    }
    return "";
  }).filter(Boolean).join("\n").trim();
  return text || (residual.length > 0 ? JSON.stringify(residual) : "");
}
