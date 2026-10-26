import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

test("actual Anthropic-to-Gemini gateway preserves parallel tool-result images across historical streaming and nonstreaming requests", { timeout: 30000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ccr-tool-images-"));
  const captures = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    captures.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "images reviewed" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 2, totalTokenCount: 22 } }));
  });
  let child;
  let exited;
  let output = "";
  try {
    await listen(upstream);
    const reservation = createServer();
    await listen(reservation);
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const configFile = path.join(root, "gateway.json");
    writeFileSync(configFile, JSON.stringify({
      host: "127.0.0.1", port, logging: { enabled: false }, auth: { enabled: false },
      providers: [{ name: "test-gemini", type: "gemini_generate_content", baseurl: `http://127.0.0.1:${upstream.address().port}/api/gemini`, apikey: "test-only", models: ["gemini-4-argon"] }],
      plugins: [{ key: "ccr-test-boundary", modulePath: path.resolve(".test-dist/core/runtime/upstream-header-sanitizer.js") }]
    }));
    child = spawn(process.execPath, [path.resolve("node_modules/@the-next-ai/ai-gateway/dist/index.js")], {
      cwd: root, env: { PATH: process.env.PATH, GATEWAY_CONFIG_PATH: configFile }, stdio: ["ignore", "pipe", "pipe"]
    });
    exited = once(child, "exit");
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-8000); });
    child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-8000); });
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error(output);
      try { ready = (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
      if (ready) break;
      await delay(50);
    }
    assert.ok(ready, output);
    const image = (data) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
    const body = { model: "gemini-4-argon", max_tokens: 100, tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }], messages: [
      { role: "user", content: "Review files" },
      { role: "assistant", content: ["a", "b"].map((id) => ({ type: "tool_use", id, name: "Read", input: {} })) },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "b", content: [image("Yg=="), image("Yw==")] },
        { type: "tool_result", tool_use_id: "a", is_error: true, content: [{ type: "text", text: "image metadata" }, image("YQ==")] }
      ] }
    ] };
    for (const stream of [false, true]) {
      const response = await fetch(`${origin}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5000), body: JSON.stringify({ ...body, stream }) });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.match(text, /images reviewed/);
      const results = captures.at(-1).contents.flatMap((turn) => turn.parts).filter((part) => part.functionResponse).map((part) => part.functionResponse);
      assert.deepEqual(results.map((result) => result.id), ["b", "a"]);
      assert.deepEqual(results.map((result) => result.parts.map((part) => part.inlineData.data)), [["Yg==", "Yw=="], ["YQ=="]]);
      assert.equal(results[0].response.content, "");
      assert.equal(results[1].response.content, "image metadata");
      assert.equal(results[1].response.is_error, true);
      assert.ok(!JSON.stringify(results.map((result) => result.response)).includes("base64"));
      body.messages.push({ role: "assistant", content: "Reviewed." }, { role: "user", content: "Review the same images again." });
    }
    assert.equal(captures.length, 2);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(force);
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}
