import assert from "node:assert/strict";
import test from "node:test";
import { applyGeminiRequestSanitizer } from "@ccr/core/gateway/core-runtime/gemini-request-sanitizer.ts";
import { createGatewayPlugin } from "@ccr/core/gateway/core-runtime/upstream-header-sanitizer.ts";

const image = (data = "cGljdHVyZQ==", media_type = "image/png") => ({
  type: "image", source: { type: "base64", media_type, data }
});
const toolResult = (id, content, extra = {}) => ({ type: "tool_result", tool_use_id: id, content, ...extra });
const functionResult = (id, content, extra = {}) => ({
  functionResponse: { id, name: "Read", response: { content }, ...extra }
});
const request = (parts) => ({
  url: "http://localhost/api/gemini/v1beta/models/gemini-4-argon:generateContent",
  bodyEncoding: "json", body: { contents: [{ role: "user", parts }] }
});
const source = (...results) => ({ messages: [{ role: "user", content: results }] });
const sanitize = (upstream, sourceBody) => applyGeminiRequestSanitizer(upstream, { type: "gemini" }, { sourceBody });
const responses = (value) => value.body.contents.flatMap((turn) => turn.parts).map((part) => part.functionResponse ?? part.function_response).filter(Boolean);

test("image-only tool results become native media without base64 text, mutation or retry duplication", () => {
  const blocks = [image()];
  const original = request([functionResult("read-1", JSON.stringify(blocks))]);
  const sourceBody = source(toolResult("read-1", blocks));
  const before = structuredClone({ original, sourceBody });
  const result = sanitize(original, sourceBody);
  assert.deepEqual(responses(result)[0], {
    id: "read-1", name: "Read", response: { content: "" },
    parts: [{ inlineData: { mimeType: "image/png", data: "cGljdHVyZQ==" } }]
  });
  assert.deepEqual({ original, sourceBody }, before);
  assert.strictEqual(sanitize(result, sourceBody), result);
  assert.deepEqual(sanitize(original, sourceBody), result);
});

test("parallel and historical results keep their IDs, image order, text, errors and tool references", () => {
  const a = image("YQ==");
  const b = image("Yg==", "image/jpeg");
  const c = image("Yw==");
  const references = '\n[{"type":"tool_reference","tool_name":"loaded_tool"}]';
  const sourceBody = { messages: [
    { role: "user", content: [toolResult("old", [a])] },
    { role: "user", content: [
      toolResult("b", [{ type: "text", text: "  screenshot description  " }, b], { is_error: true }),
      toolResult("a", [a, c, { type: "tool_reference", tool_name: "loaded_tool" }]),
      toolResult("search", [{ type: "tool_reference", tool_name: "loaded_tool" }])
    ] }
  ] };
  const upstream = request([
    functionResult("old", JSON.stringify([a])),
    { functionResponse: { id: "b", name: "capture", response: { content: "screenshot description", is_error: true, custom: "preserve" } } },
    functionResult("a", JSON.stringify([a, c]) + references),
    functionResult("search", references.trim()),
    { text: "Continue reviewing." }
  ]);
  const result = sanitize(upstream, sourceBody);
  const actual = responses(result);
  assert.deepEqual(actual.map((value) => value.id), ["old", "b", "a", "search"]);
  assert.deepEqual(actual.map((value) => value.parts?.map((part) => part.inlineData.data)), [["YQ=="], ["Yg=="], ["YQ==", "Yw=="], undefined]);
  assert.deepEqual(actual[1].response, { content: "screenshot description", is_error: true, custom: "preserve" });
  assert.equal(actual[2].response.content, references);
  assert.equal(actual[3].response.content, references.trim());
  assert.deepEqual(result.body.contents.at(-1), { role: "user", parts: [{ text: "Continue reviewing." }] });
});

test("reused tool IDs are matched by occurrence, including text-only results", () => {
  const a = image("YQ==");
  const b = image("Yg==");
  const result = sanitize(request([
    functionResult("reused", "text only"),
    functionResult("reused", JSON.stringify([a])),
    functionResult("reused", JSON.stringify([b]))
  ]), source(toolResult("reused", "text only"), toolResult("reused", [a]), toolResult("reused", [b])));
  assert.deepEqual(responses(result).map((value) => value.parts?.[0].inlineData.data), [undefined, "YQ==", "Yg=="]);
});

test("existing native media is preserved and identical source images retain multiplicity", () => {
  const a = image();
  const existing = { inlineData: { mimeType: "image/png", data: a.source.data } };
  const result = sanitize(request([functionResult("1", "", { parts: [existing] })]), source(toolResult("1", [a, a])));
  assert.deepEqual(responses(result)[0].parts, [existing, existing]);
  assert.strictEqual(sanitize(result, source(toolResult("1", [a, a]))), result);
});

test("snake-case native function responses and image fields stay valid", () => {
  const a = image();
  const upstream = request([{ function_response: { id: "1", name: "Read", response: { content: "" }, parts: [
    { inline_data: { mime_type: "image/png", data: a.source.data } }
  ] } }]);
  assert.strictEqual(sanitize(upstream, source(toolResult("1", [a]))), upstream);
});

test("ordinary output, non-Anthropic sources and non-Gemini requests are unchanged", () => {
  const upstream = request([functionResult("1", '{"data":"not an image"}')]);
  assert.strictEqual(sanitize(upstream, source(toolResult("1", upstream.body.contents[0].parts[0].functionResponse.response.content))), upstream);
  assert.strictEqual(sanitize(upstream, undefined), upstream);
  assert.strictEqual(sanitize(upstream, { contents: [] }), upstream);
  const chat = { url: "http://localhost/v1/chat/completions", body: { messages: [] } };
  assert.strictEqual(applyGeminiRequestSanitizer(chat, { type: "openai_chat_completions" }, { sourceBody: source(toolResult("1", [image()])) }), chat);
});

test("structured non-image content and adapter suffixes survive image removal", () => {
  const a = image();
  const document = { type: "document", source: { type: "text", data: "document text" } };
  const result = sanitize(request([functionResult("1", JSON.stringify([document, a]) + "\nreference suffix")]), source(toolResult("1", [document, a])));
  assert.equal(responses(result)[0].response.content, JSON.stringify([document]) + "\nreference suffix");
});

test("unsupported or malformed tool images return an explicit provider error without fetching", () => {
  const hook = createGatewayPlugin().providerHooks[0];
  for (const block of [
    { type: "image", source: { type: "url", url: "http://127.0.0.1/private" } },
    { type: "image", source: { type: "base64", data: "YQ==" } }
  ]) {
    const result = hook.transformRequest({ request: { body: source(toolResult("1", [block])) }, upstreamRequest: { ...request([functionResult("1", JSON.stringify([block]))]), headers: {} } });
    assert.equal(result.ok, false);
    assert.match(result.error, /Cannot convert image in tool result 1: expected base64 image data/);
    assert.ok(!result.error.includes("private"));
  }
});
