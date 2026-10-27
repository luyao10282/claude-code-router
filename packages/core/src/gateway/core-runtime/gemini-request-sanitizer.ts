import { isRecord } from "@ccr/core/gateway/internal/value";
import { createGeminiToolResultImageRestorer } from "@ccr/core/gateway/core-runtime/gemini-tool-result-images";

type UpstreamRequest = {
  body?: unknown;
  bodyEncoding?: "bytes" | "form" | "json" | "none" | "text";
  url: string;
};

type TargetProviderConfig = {
  modelMetadata?: Record<string, {
    supportedReasoningLevels?: Array<{ effort: string }>;
  }>;
  type?: string;
};

type GeminiRequestSanitizerOptions = {
  model?: string;
  sourceBody?: unknown;
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

const geminiEffortRanks: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 6
};

function readGeminiEffortRank(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return geminiEffortRanks[value.trim().toLowerCase()];
}

function requestedGeminiEffortRank(sourceBody: unknown): number | undefined {
  if (!isRecord(sourceBody)) {
    return undefined;
  }
  const reasoning = isRecord(sourceBody.reasoning) ? sourceBody.reasoning : undefined;
  const outputConfig = isRecord(sourceBody.output_config) ? sourceBody.output_config : undefined;
  return readGeminiEffortRank(reasoning?.effort) ??
    readGeminiEffortRank(sourceBody.reasoning_effort) ??
    readGeminiEffortRank(outputConfig?.effort);
}

function normalizedGeminiModelName(value: string | undefined): string | undefined {
  return value?.trim().replace(/\[1m\]$/i, "").split("/").pop() || undefined;
}

function supportedGeminiEfforts(
  targetProviderConfig: TargetProviderConfig | undefined,
  model: string | undefined,
  requestUrl: string
): string[] {
  const metadata = targetProviderConfig?.modelMetadata;
  if (!metadata) {
    return [];
  }
  const urlModel = /\/models\/([^/:]+):/i.exec(requestUrl)?.[1];
  const candidates = [model, normalizedGeminiModelName(model), normalizedGeminiModelName(urlModel)].filter(
    (value): value is string => Boolean(value)
  );
  const modelMetadata = candidates.map((candidate) => metadata[candidate]).find(Boolean);
  if (!modelMetadata?.supportedReasoningLevels) {
    return [];
  }
  return [...new Set(modelMetadata.supportedReasoningLevels
    .map((level) => level.effort.trim().toLowerCase())
    .filter((effort) => ["low", "medium", "high"].includes(effort)))];
}

function resolveGeminiThinkingLevel(
  sourceBody: unknown,
  targetProviderConfig: TargetProviderConfig | undefined,
  model: string | undefined,
  requestUrl: string
): string | undefined {
  const requestedRank = requestedGeminiEffortRank(sourceBody);
  const supportedEfforts = supportedGeminiEfforts(targetProviderConfig, model, requestUrl);
  if (requestedRank === undefined || supportedEfforts.length === 0) {
    return undefined;
  }
  const selected = supportedEfforts.reduce((best, effort) => {
    const distance = Math.abs(geminiEffortRanks[effort] - requestedRank);
    const bestDistance = Math.abs(geminiEffortRanks[best] - requestedRank);
    return distance < bestDistance ||
      (distance === bestDistance && geminiEffortRanks[effort] < geminiEffortRanks[best])
      ? effort
      : best;
  });
  return selected.toUpperCase();
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
 * 4. Maps and clamps client reasoning effort to `thinkingLevel` for models with declared
 *    supported reasoning levels after provider defaults are merged.
 * 5. Strips malformed non-base64 `thoughtSignature` fields.
 * 6. Restores Anthropic tool-result images as native functionResponse media.
 * 7. Merges consecutive `functionResponse`-only `user` turns into a single `user` turn.
 */
export function applyGeminiRequestSanitizer<T extends UpstreamRequest>(
  request: T,
  targetProviderConfig?: TargetProviderConfig,
  options: GeminiRequestSanitizerOptions = {}
): T {
  if (!isGeminiGenerateContentRequest(request, targetProviderConfig) || !isRecord(request.body)) {
    return request;
  }

  const body = request.body;
  const rawContents = Array.isArray(body.contents) ? body.contents : [];
  const restoreToolResultImages = createGeminiToolResultImageRestorer(options.sourceBody);
  let contentsChanged = false;
  let previousTurnIsPureFunctionResponseUser = false;
  const nextContents: unknown[] = [];

  for (const turn of rawContents) {
    if (!isRecord(turn) || !Array.isArray(turn.parts)) {
      previousTurnIsPureFunctionResponseUser = false;
      nextContents.push(turn);
      continue;
    }

    let partsChanged = false;
    const sanitizedParts = turn.parts.map((part) => {
      const restored = turn.role === "user" ? restoreToolResultImages(part) : part;
      const sanitized = sanitizePartThoughtSignature(restored);
      if (sanitized.changed || restored !== part) {
        partsChanged = true;
      }
      return sanitized.value;
    });

    if (turn.role === "user") {
      const fnParts = sanitizedParts.filter(isFunctionResponsePart);
      const otherParts = sanitizedParts.filter((part) => !isFunctionResponsePart(part));
      if (fnParts.length > 0 && otherParts.length > 0) {
        contentsChanged = true;
        previousTurnIsPureFunctionResponseUser = false;
        nextContents.push(
          { ...turn, role: "user", parts: fnParts },
          { ...turn, role: "user", parts: otherParts }
        );
        continue;
      }
      if (fnParts.length > 0) {
        const previousTurn = nextContents[nextContents.length - 1];
        if (
          previousTurnIsPureFunctionResponseUser &&
          isRecord(previousTurn) &&
          Array.isArray(previousTurn.parts)
        ) {
          contentsChanged = true;
          nextContents[nextContents.length - 1] = {
            ...previousTurn,
            parts: [...previousTurn.parts, ...sanitizedParts]
          };
          continue;
        }
        previousTurnIsPureFunctionResponseUser = true;
        if (partsChanged) {
          contentsChanged = true;
          nextContents.push({ ...turn, parts: sanitizedParts });
        } else {
          nextContents.push(turn);
        }
        continue;
      }
    }

    previousTurnIsPureFunctionResponseUser = false;
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
  const requestedThinkingLevel = resolveGeminiThinkingLevel(
    options.sourceBody,
    targetProviderConfig,
    options.model,
    request.url
  );
  if (requestedThinkingLevel) {
    const generationConfig = isRecord(body.generationConfig) ? body.generationConfig : {};
    const thinkingConfig = isRecord(generationConfig.thinkingConfig) ? generationConfig.thinkingConfig : {};
    const currentThinkingLevel = thinkingConfig.thinkingLevel ?? thinkingConfig.thinking_level;
    if (currentThinkingLevel !== requestedThinkingLevel || Object.hasOwn(thinkingConfig, "thinking_level")) {
      const nextThinkingConfig: Record<string, unknown> = { ...thinkingConfig, thinkingLevel: requestedThinkingLevel };
      delete nextThinkingConfig.thinking_level;
      nextGenerationConfig = { ...generationConfig, thinkingConfig: nextThinkingConfig };
      generationConfigChanged = true;
    }
  }

  if (isRecord(nextGenerationConfig) && isRecord(nextGenerationConfig.thinkingConfig)) {
    const thinkingConfig = nextGenerationConfig.thinkingConfig;
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
        ...nextGenerationConfig,
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
