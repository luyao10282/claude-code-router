import { isRecord } from "@ccr/core/gateway/internal/value";

type UpstreamRequest = {
  body?: unknown;
  bodyEncoding?: "bytes" | "form" | "json" | "none" | "text";
  url: string;
};

type TargetProviderConfig = {
  type?: string;
};

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(value: unknown): boolean {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length % 4 === 0 &&
    base64SignaturePattern.test(value);
}

function isFunctionResponsePart(part: unknown): boolean {
  return isRecord(part) && (isRecord(part.functionResponse) || isRecord(part.function_response));
}

function sanitizePartThoughtSignature(part: unknown): { changed: boolean; value: unknown } {
  if (!isRecord(part)) {
    return { changed: false, value: part };
  }
  let next: Record<string, unknown> | undefined;
  for (const key of ["thoughtSignature", "thought_signature"]) {
    if (Object.hasOwn(part, key) && !isValidThoughtSignature(part[key])) {
      next ??= { ...part };
      delete next[key];
    }
  }
  return next ? { changed: true, value: next } : { changed: false, value: part };
}

function isGeminiGenerateContentRequest(
  request: UpstreamRequest,
  targetProviderConfig?: TargetProviderConfig
): boolean {
  if ((request.bodyEncoding ?? "json") !== "json" || !isRecord(request.body)) {
    return false;
  }
  if (!Array.isArray(request.body.contents)) {
    return false;
  }
  if (/^gemini(?:_|$)/i.test(targetProviderConfig?.type?.trim() ?? "")) {
    return true;
  }
  return /:(?:generateContent|streamGenerateContent)(?:\?|$)/i.test(request.url);
}

/**
 * Normalizes Gemini generateContent payloads before they cross the upstream boundary:
 * 1. Splits `user` turns that mix `functionResponse` and `text`/media parts into two
 *    consecutive `user` turns (strict Vertex / Gemini generateContent gateways reject a
 *    final `user` turn mixing `functionResponse` and `text` with HTTP 400 "Requests
 *    ending with a model turn are not supported", which otherwise triggers after every
 *    ToolSearch or user-interrupted tool turn in Claude Code).
 * 2. Appends a continuation `user` turn when `contents` ends on a `model` turn
 *    (Anthropic assistant prefill / background agent summary).
 * 3. Removes `thinkingBudget` from `generationConfig.thinkingConfig` when `thinkingLevel`
 *    is present or when targeting Gemini 3/4 models (fixes HTTP 400 on Claude Code
 *    auto-mode classifier / sideQuery requests that send `thinking: { type: "disabled" }`).
 * 4. Strips malformed non-base64 `thoughtSignature` fields.
 */
export function applyGeminiRequestSanitizer<T extends UpstreamRequest>(
  request: T,
  targetProviderConfig?: TargetProviderConfig
): T {
  if (!isGeminiGenerateContentRequest(request, targetProviderConfig) || !isRecord(request.body)) {
    return request;
  }

  const body = request.body;
  const rawContents = Array.isArray(body.contents) ? body.contents : [];
  let contentsChanged = false;
  const nextContents: unknown[] = [];

  for (const turn of rawContents) {
    if (!isRecord(turn) || !Array.isArray(turn.parts)) {
      nextContents.push(turn);
      continue;
    }

    let partsChanged = false;
    const sanitizedParts = turn.parts.map((part) => {
      const sanitized = sanitizePartThoughtSignature(part);
      if (sanitized.changed) {
        partsChanged = true;
      }
      return sanitized.value;
    });

    if (turn.role === "user") {
      const fnParts = sanitizedParts.filter(isFunctionResponsePart);
      const otherParts = sanitizedParts.filter((part) => !isFunctionResponsePart(part));
      if (fnParts.length > 0 && otherParts.length > 0) {
        contentsChanged = true;
        nextContents.push(
          { ...turn, role: "user", parts: fnParts },
          { ...turn, role: "user", parts: otherParts }
        );
        continue;
      }
    }

    if (partsChanged) {
      contentsChanged = true;
      nextContents.push({ ...turn, parts: sanitizedParts });
    } else {
      nextContents.push(turn);
    }
  }

  if (nextContents.length > 0) {
    const lastTurn = nextContents[nextContents.length - 1];
    if (isRecord(lastTurn) && lastTurn.role === "model") {
      contentsChanged = true;
      nextContents.push({
        role: "user",
        parts: [{ text: "Continue." }]
      });
    }
  }

  let nextGenerationConfig = body.generationConfig;
  let generationConfigChanged = false;
  if (isRecord(body.generationConfig) && isRecord(body.generationConfig.thinkingConfig)) {
    const thinkingConfig = body.generationConfig.thinkingConfig;
    const hasThinkingBudget =
      Object.hasOwn(thinkingConfig, "thinkingBudget") ||
      Object.hasOwn(thinkingConfig, "thinking_budget");
    const hasThinkingLevel =
      Object.hasOwn(thinkingConfig, "thinkingLevel") ||
      Object.hasOwn(thinkingConfig, "thinking_level");
    const isGemini3Or4Url = /\/models\/gemini-[34][0-9a-z.-]*:/i.test(request.url);

    if (hasThinkingBudget && (hasThinkingLevel || isGemini3Or4Url)) {
      const nextThinkingConfig = { ...thinkingConfig };
      delete nextThinkingConfig.thinkingBudget;
      delete nextThinkingConfig.thinking_budget;
      generationConfigChanged = true;
      nextGenerationConfig = {
        ...body.generationConfig,
        ...(Object.keys(nextThinkingConfig).length > 0
          ? { thinkingConfig: nextThinkingConfig }
          : {})
      };
      if (Object.keys(nextThinkingConfig).length === 0) {
        delete (nextGenerationConfig as Record<string, unknown>).thinkingConfig;
      }
    }
  }

  if (!contentsChanged && !generationConfigChanged) {
    return request;
  }

  return {
    ...request,
    body: {
      ...body,
      ...(contentsChanged ? { contents: nextContents } : {}),
      ...(generationConfigChanged ? { generationConfig: nextGenerationConfig } : {})
    }
  };
}
