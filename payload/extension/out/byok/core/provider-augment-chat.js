"use strict";

const { traceAsyncGenerator } = require("../infra/trace");
const { debug } = require("../infra/log");
const { normalizeString } = require("../infra/util");
const { formatKnownProviderTypes } = require("./provider-types");
const { applyEmergencyContextCompactionForRetry } = require("./augment-history-summary");
const { readMaxTokensFromRequestDefaults, computeReducedMaxTokens, rewriteRequestDefaultsWithMaxTokens, isLikelyMaxTokensErrorMessage } = require("./token-budget/max-tokens-retry");
const {
  buildSystemPrompt,
  convertOpenAiTools,
  convertOpenAiResponsesTools,
  convertAnthropicTools,
  convertGeminiTools,
  buildOpenAiMessages,
  buildOpenAiResponsesInput,
  buildAnthropicMessages,
  buildGeminiContents
} = require("./augment-chat");

const { openAiCompleteText, openAiChatStreamChunks } = require("../providers/openai");
const { openAiResponsesCompleteText, openAiResponsesChatStreamChunks } = require("../providers/openai-responses");
const { anthropicCompleteText, anthropicChatStreamChunks } = require("../providers/anthropic");
const { geminiCompleteText, geminiChatStreamChunks } = require("../providers/gemini");

const CONTEXT_RETRY_DEFAULT_MAX_ATTEMPTS = 5; // original + 4 retries

function convertToolDefinitionsByProviderType(type, toolDefs) {
  const t = normalizeString(type);
  if (t === "openai_compatible") return convertOpenAiTools(toolDefs);
  if (t === "anthropic") return convertAnthropicTools(toolDefs);
  if (t === "openai_responses") return convertOpenAiResponsesTools(toolDefs);
  if (t === "gemini_ai_studio") return convertGeminiTools(toolDefs);
  throw new Error(`未知 provider.type: ${t}（支持：${formatKnownProviderTypes()}）`);
}

function normalizeMaxAttempts(maxAttempts) {
  const n = Number(maxAttempts);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return CONTEXT_RETRY_DEFAULT_MAX_ATTEMPTS;
}

function computeNextRequestDefaultsForRetry(requestDefaults, errorMessage) {
  const rd = requestDefaults && typeof requestDefaults === "object" && !Array.isArray(requestDefaults) ? requestDefaults : {};
  const cur = readMaxTokensFromRequestDefaults(rd);
  const next = computeReducedMaxTokens({ currentMax: cur, errorMessage });
  if (next == null) return { requestDefaults: rd, changed: false, cur, next: null };
  return { requestDefaults: rewriteRequestDefaultsWithMaxTokens(rd, next), changed: true, cur, next };
}

function applyEmergencyContextCompactionForProviderRetry(req, { level, label, attempt, maxAttempts } = {}) {
  const res = applyEmergencyContextCompactionForRetry(req, { level });
  if (!res || typeof res !== "object" || res.changed !== true) return { changed: false };

  if (res.kind === "summary") {
    debug(
      `[context-retry] ${normalizeString(label) || "llm"} attempt=${attempt}/${maxAttempts} shrink summary: end_part_full_max_chars=${Number(res.endPartFullMaxChars) || 0} history_end=${Number(res.historyEndBefore) || 0}->${Number(res.historyEndAfter) || 0} where=${normalizeString(res.where) || "unknown"}`
    );
  } else if (res.kind === "history") {
    debug(
      `[context-retry] ${normalizeString(label) || "llm"} attempt=${attempt}/${maxAttempts} shrink chat_history: ${Number(res.chatHistoryBefore) || 0}->${Number(res.chatHistoryAfter) || 0}`
    );
  } else {
    debug(`[context-retry] ${normalizeString(label) || "llm"} attempt=${attempt}/${maxAttempts} shrink applied`);
  }

  return { changed: true, detail: res };
}

async function runWithContextRetry(callOnce, { requestDefaults, req, label, maxAttempts, abortSignal } = {}) {
  const attempts = normalizeMaxAttempts(maxAttempts);
  let rd = requestDefaults;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (abortSignal && abortSignal.aborted) throw new Error("Aborted");
    try {
      return await callOnce(rd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const canRetry = attempt < attempts && isLikelyMaxTokensErrorMessage(msg);
      if (!canRetry) throw err;

      const { requestDefaults: nextRd, changed: maxTokensChanged, cur, next } = computeNextRequestDefaultsForRetry(rd, msg);
      if (maxTokensChanged) {
        debug(
          `[max-tokens-retry] ${normalizeString(label) || "llm"} attempt=${attempt}/${attempts} reducing max_tokens: ${Number(cur) || 0} -> ${next}`
        );
        rd = nextRd;
      }

      const { changed: inputChanged } = applyEmergencyContextCompactionForProviderRetry(req, {
        level: attempt,
        label,
        attempt,
        maxAttempts: attempts
      });

      if (!maxTokensChanged && !inputChanged) throw err;
    }
  }

  // unreachable
  return await callOnce(rd);
}

async function completeAugmentChatTextByProviderType({
  type,
  baseUrl,
  apiKey,
  model,
  req,
  timeoutMs,
  abortSignal,
  extraHeaders,
  requestDefaults
}) {
  const t = normalizeString(type);
  const lab = `complete/${t || "unknown"}`;
  const callOnce = async (rd) => {
    if (t === "openai_compatible") {
      return await openAiCompleteText({
        baseUrl,
        apiKey,
        model,
        messages: buildOpenAiMessages(req),
        timeoutMs,
        abortSignal,
        extraHeaders,
        requestDefaults: rd
      });
    }
    if (t === "anthropic") {
      return await anthropicCompleteText({
        baseUrl,
        apiKey,
        model,
        system: buildSystemPrompt(req),
        messages: buildAnthropicMessages(req),
        timeoutMs,
        abortSignal,
        extraHeaders,
        requestDefaults: rd
      });
    }
    if (t === "openai_responses") {
      const { instructions, input } = buildOpenAiResponsesInput(req);
      return await openAiResponsesCompleteText({
        baseUrl,
        apiKey,
        model,
        instructions,
        input,
        timeoutMs,
        abortSignal,
        extraHeaders,
        requestDefaults: rd
      });
    }
    if (t === "gemini_ai_studio") {
      const { systemInstruction, contents } = buildGeminiContents(req);
      return await geminiCompleteText({
        baseUrl,
        apiKey,
        model,
        systemInstruction,
        contents,
        timeoutMs,
        abortSignal,
        extraHeaders,
        requestDefaults: rd
      });
    }
    throw new Error(`未知 provider.type: ${t}（支持：${formatKnownProviderTypes()}）`);
  };

  return await runWithContextRetry(async (rd) => await callOnce(rd), { requestDefaults, req, label: lab, abortSignal });
}

function normalizeTraceLabel(traceLabel) {
  return normalizeString(traceLabel);
}

async function* traceIfNeeded(label, src) {
  const lab = normalizeTraceLabel(label);
  if (!lab) {
    yield* src;
    return;
  }
  yield* traceAsyncGenerator(lab, src);
}

async function* streamAugmentChatChunksByProviderType({
  type,
  baseUrl,
  apiKey,
  model,
  req,
  timeoutMs,
  abortSignal,
  extraHeaders,
  requestDefaults,
  toolMetaByName,
  supportToolUseStart,
  supportParallelToolUse,
  traceLabel,
  nodeIdStart
}) {
  const t = normalizeString(type);
  const tl = normalizeTraceLabel(traceLabel);
  const tools = convertToolDefinitionsByProviderType(t, req?.tool_definitions);

  const label = tl ? `${tl} ${t || "unknown"}` : `${t || "unknown"}`;
  const lab = `stream/${t || "unknown"}`;
  let rd = requestDefaults;
  const maxAttempts = CONTEXT_RETRY_DEFAULT_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (abortSignal && abortSignal.aborted) throw new Error("Aborted");
    let emitted = false;
    try {
      let gen;
      if (t === "openai_compatible") {
        gen = openAiChatStreamChunks({
          baseUrl,
          apiKey,
          model,
          messages: buildOpenAiMessages(req),
          tools,
          timeoutMs,
          abortSignal,
          extraHeaders,
          requestDefaults: rd,
          toolMetaByName,
          supportToolUseStart,
          supportParallelToolUse,
          nodeIdStart
        });
      } else if (t === "anthropic") {
        gen = anthropicChatStreamChunks({
          baseUrl,
          apiKey,
          model,
          system: buildSystemPrompt(req),
          messages: buildAnthropicMessages(req),
          tools,
          timeoutMs,
          abortSignal,
          extraHeaders,
          requestDefaults: rd,
          toolMetaByName,
          supportToolUseStart,
          nodeIdStart
        });
      } else if (t === "openai_responses") {
        const { instructions, input } = buildOpenAiResponsesInput(req);
        gen = openAiResponsesChatStreamChunks({
          baseUrl,
          apiKey,
          model,
          instructions,
          input,
          tools,
          timeoutMs,
          abortSignal,
          extraHeaders,
          requestDefaults: rd,
          toolMetaByName,
          supportToolUseStart,
          supportParallelToolUse,
          nodeIdStart
        });
      } else if (t === "gemini_ai_studio") {
        const { systemInstruction, contents } = buildGeminiContents(req);
        gen = geminiChatStreamChunks({
          baseUrl,
          apiKey,
          model,
          systemInstruction,
          contents,
          tools,
          timeoutMs,
          abortSignal,
          extraHeaders,
          requestDefaults: rd,
          toolMetaByName,
          supportToolUseStart,
          nodeIdStart
        });
      } else {
        throw new Error(`未知 provider.type: ${t}（支持：${formatKnownProviderTypes()}）`);
      }

      const traced = traceIfNeeded(label, gen);
      for await (const chunk of traced) {
        emitted = true;
        yield chunk;
      }
      return;
    } catch (err) {
      if (emitted) throw err;

      const msg = err instanceof Error ? err.message : String(err);
      const canRetry = attempt < maxAttempts && isLikelyMaxTokensErrorMessage(msg);
      if (!canRetry) throw err;

      const { requestDefaults: nextRd, changed: maxTokensChanged, cur, next } = computeNextRequestDefaultsForRetry(rd, msg);
      if (maxTokensChanged) {
        debug(`[max-tokens-retry] ${lab} attempt=${attempt}/${maxAttempts} reducing max_tokens: ${Number(cur) || 0} -> ${next}`);
        rd = nextRd;
      }

      const { changed: inputChanged } = applyEmergencyContextCompactionForProviderRetry(req, {
        level: attempt,
        label: lab,
        attempt,
        maxAttempts
      });

      if (!maxTokensChanged && !inputChanged) throw err;
    }
  }

  throw new Error(`未知 provider.type: ${t}（支持：${formatKnownProviderTypes()}）`);
}

module.exports = { convertToolDefinitionsByProviderType, completeAugmentChatTextByProviderType, streamAugmentChatChunksByProviderType };
