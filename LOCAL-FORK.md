# Local fork notes

This clone is the local source repository for `@musistudio/claude-code-router` (CCR 3.x), used to maintain personal compatibility patches for Gemini / Vertex `generateContent` gateways on top of upstream `origin/main`.

## Remotes & Branches

- `origin` (`https://github.com/musistudio/claude-code-router.git`) — upstream, fetch-only (`origin/main`).
- `fork` (`git@github.com:luyao10282/claude-code-router.git`) — personal GitHub fork.
- `local/genai-bridge-compat` — the branch in use, tracked on `fork/local/genai-bridge-compat`. Keep all local changes on this branch, one commit per logical change, and keep generated files (`packages/core/models.json`) clean to avoid upstream merge conflicts.

## Local changes

1. **Gemini `generateContent` request sanitizer** (`packages/core/src/gateway/core-runtime/gemini-request-sanitizer.ts`, wired into `packages/core/src/gateway/core-runtime/upstream-header-sanitizer.ts` and covered by `packages/core/test/unit/gateway/upstream-header-sanitizer.test.mjs`):
   - **Split mixed `user` turns (`[functionResponse, text]` -> two `user` turns)**: Claude Code appends `{ type: "text", text: "Tool loaded." }` to the same `user` message as `tool_result` whenever `ToolSearch` loads deferred tools (`ENABLE_TOOL_SEARCH=true`), and appends `[Request interrupted by user]` + the next prompt to `tool_result` when a tool call is interrupted. Strict Gemini/Vertex gateways reject a final `user` turn mixing `functionResponse` and `text` parts with `HTTP 400: Requests ending with a model turn are not supported.` Splitting `functionResponse` parts and other parts into two consecutive `user` turns eliminates the 400.
   - **Append continuation `user` turn after a trailing `model` turn**: When `contents` ends on a `model` turn (e.g. Anthropic assistant prefill or background subagent summary), appends `{ role: "user", parts: [{ text: "Continue." }] }`.
   - **Strip `thinkingBudget` when `thinkingLevel` is set (or on Gemini 3/4 models)**: Claude Code's auto-mode classifier (`yoloClassifier`) and `sideQuery` send `thinking: { type: "disabled" }`, which `@the-next-ai/ai-gateway` converts to `thinkingBudget: 0`. Merging that with provider `extraBody` (`thinkingLevel: "HIGH"`) causes Gemini 3/4 to reject the request with `HTTP 400: Unable to submit request because thinking_budget and thinking_level are not supported together.`
   - **Map and clamp client reasoning effort**: Reads `reasoning.effort`, `reasoning_effort`, and `output_config.effort` after provider defaults are merged, then selects the nearest level declared by the target model's `supportedReasoningLevels`. `none`/`minimal` clamp to `LOW`, while `xhigh`/`max`/`ultra` clamp to `HIGH`. `packages/core/src/providers/runtime-topology.ts` passes the existing model metadata through to the hook. Models without declared levels keep their previous behavior, so this is a generic capability-gated Gemini mapping rather than an endpoint-specific special case.
   - **Strip malformed non-base64 `thoughtSignature` fields**.
   - **Restore tool-result images** (`gemini-tool-result-images.ts`): recover base64 images from the original Anthropic `tool_result` blocks and attach them to the matching Gemini `functionResponse.parts`. ai-gateway 1.0.21 otherwise serializes image-only results into base64 JSON text and silently drops images when text is also present. Preserve call IDs, parallel result ordering, historical images, error flags, tool references, and existing native media; retries are idempotent. Unsupported URL or malformed images fail explicitly without fetching remote content. Unit and actual-gateway integration tests cover the repair; no transcript edits are required for existing sessions.
     - Runtime validation uses the real Claude Code Read loop through the Apple wrapper, CCR, and the native bridge, plus replay of a failed request with its full history and image results. Verify native image usage and the returned visual content; HTTP success alone is insufficient.

2. **Gemini `thoughtsTokenCount` usage preservation during build** (`build/esbuild.config.mjs`):
   - Preserves `usageMetadata.thoughtsTokenCount` as `reasoning_tokens` and maps it into Anthropic `usage.output_tokens` + `usage.output_tokens_details.thinking_tokens` when bundling `next-ai-gateway.js`.

## Upgrading to a newer upstream & deploying to global `ccr`

```bash
cd ~/dev2/ai项目/claude-code-router
git fetch origin
git merge origin/main            # resolve conflicts if any, keep local commits
npm install --ignore-scripts
npm run typecheck
node build/test.mjs core
node --test .test-dist/core/test/unit/gateway/upstream-header-sanitizer.test.js \
  .test-dist/core/test/unit/gateway/gemini-tool-result-images.test.js \
  .test-dist/core/test/integration/gateway/gemini-tool-result-images.test.js \
  .test-dist/core/test/integration/gateway/anthropic-tool-ids.test.js
npm run build:assets
git checkout -- packages/core/models.json
git push fork main local/genai-bridge-compat

# Sync built CLI/gateway assets to the global @musistudio/claude-code-router installation and restart CCR
rsync -a --delete packages/cli/dist/ /opt/homebrew/lib/node_modules/@musistudio/claude-code-router/dist/
ccr stop && ccr start --no-open
```
