"use strict";

// 单一真相：LLM 端点集合（13）+ 输入/输出形状摘要 + 上游期望 Back 类型
// - 用于生成覆盖矩阵报告（markdown）
// - 用于 CI fail-fast：上游若移除/新增/改变调用类型（callApi vs callApiStream）会直接失败

const LLM_ENDPOINT_SPECS = [
  {
    endpoint: "/get-models",
    kind: "callApi",
    upstreamBackType: "BackGetModelsResult",
    inputKeys: [],
    outputKeys: ["default_model", "models[].{name,suggested_prefix_char_count,suggested_suffix_char_count,completion_timeout_ms?,internal_name?}", "feature_flags", "languages?", "user_tier?", "user?"],
    byokImpl: "shim.maybeHandleCallApi(/get-models): merge official + add byok:* models"
  },
  {
    endpoint: "/chat",
    kind: "callApi",
    upstreamBackType: "BackChatResult",
    inputKeys: ["model", "message", "chat_history", "prefix?", "selected_code?", "suffix?", "path?", "lang?", "blobs?", "user_guidelines?", "workspace_guidelines?", "tool_definitions?", "nodes?", "mode?", "persona_type?", "agent_memories?", "external_source_ids?", "user_guided_blobs?", "context_code_exchange_request_id?", "disable_auto_external_sources?", "enable_preference_collection?", "third_party_override? (stripped)"],
    outputKeys: ["text", "unknown_blob_names[]", "checkpoint_not_found", "workspace_file_chunks[].{char_start,char_end,blob_name}", "nodes?", "stop_reason?"],
    byokImpl: "shim.maybeHandleCallApi(/chat): normalizeAugmentChatRequest + historySummary -> provider.completeText(buildOpenAiMessages/buildAnthropicMessages) -> BackChatResult"
  },
  {
    endpoint: "/chat-stream",
    kind: "callApiStream",
    upstreamBackType: "BackChatResult (stream chunks)",
    inputKeys: ["model", "message", "chat_history", "prefix?", "selected_code?", "suffix?", "path?", "lang?", "blobs?", "user_guidelines?", "workspace_guidelines?", "rules?", "tool_definitions?", "nodes?", "mode?", "persona_type?", "agent_memories?", "feature_detection_flags?", "external_source_ids?", "user_guided_blobs?", "context_code_exchange_request_id?", "disable_auto_external_sources?", "silent?", "conversation_id?", "canvas_id?", "third_party_override? (stripped)"],
    outputKeys: ["text (delta)", "unknown_blob_names[]", "checkpoint_not_found", "workspace_file_chunks[].{char_start,char_end,blob_name}", "nodes? (first chunk only)", "stop_reason?"],
    byokImpl: "shim.maybeHandleCallApiStream(/chat-stream): provider SSE -> BackChatResult chunks"
  },
  {
    endpoint: "/prompt-enhancer",
    kind: "callApiStream",
    upstreamBackType: "BackChatResult (stream chunks)",
    inputKeys: ["nodes", "chat_history", "blobs?", "conversation_id?", "model", "mode?", "user_guided_blobs?", "external_source_ids?", "user_guidelines?", "workspace_guidelines?", "rules?"],
    outputKeys: ["text (enhanced prompt delta)", "unknown_blob_names[]", "checkpoint_not_found", "workspace_file_chunks[]", "nodes[] (first chunk only)"],
    byokImpl: "prompt rewrite stream (BackChatResult)"
  },
  {
    endpoint: "/completion",
    kind: "callApi",
    upstreamBackType: "BackCompletionResult",
    inputKeys: ["model", "prompt", "suffix?", "path?", "lang?", "blob_name?", "prefix_begin?", "cursor_position?", "suffix_end?", "blobs?", "recency_info?", "probe_only?", "sequence_id?", "filter_threshold?", "edit_events?"],
    outputKeys: ["text (or completion_items)", "unknown_blob_names[]", "checkpoint_not_found", "suggested_prefix_char_count?", "suggested_suffix_char_count?", "completion_timeout_ms?"],
    byokImpl: "completion prompt -> provider.completeText -> BackCompletionResult(completion_items[0].text)"
  },
  {
    endpoint: "/chat-input-completion",
    kind: "callApi",
    upstreamBackType: "BackCompletionResult",
    inputKeys: ["model", "prompt", "suffix?", "path?", "lang?", "blobs?", "recency_info?", "sequence_id?", "edit_events?"],
    outputKeys: ["text (or completion_items)", "unknown_blob_names[]", "checkpoint_not_found"],
    byokImpl: "chat-input completion prompt -> provider.completeText -> BackCompletionResult(completion_items[0].text)"
  },
  {
    endpoint: "/edit",
    kind: "callApi",
    upstreamBackType: "BackCodeEditResult",
    inputKeys: ["model", "instruction", "prefix?", "selected_text", "suffix?", "path?", "lang?", "blob_name?", "prefix_begin?", "suffix_end?", "blobs?", "sequence_id?"],
    outputKeys: ["text", "unknown_blob_names[]", "checkpoint_not_found"],
    byokImpl: "edit instruction -> provider.completeText -> BackCodeEditResult(text)"
  },
  {
    endpoint: "/instruction-stream",
    kind: "callApiStream",
    upstreamBackType: "BackChatInstructionStreamResult (stream chunks)",
    inputKeys: ["model", "instruction", "prefix?", "selected_text", "suffix?", "path?", "lang?", "blob_name?", "prefix_begin?", "suffix_end?", "blobs?", "chat_history?", "context_code_exchange_request_id?", "user_guidelines?", "workspace_guidelines?"],
    outputKeys: ["text (delta)", "replacement_text?", "replacement_old_text?", "replacement_start_line?", "replacement_end_line?"],
    byokImpl: "instruction stream -> {text,+replacement meta}"
  },
  {
    endpoint: "/smart-paste-stream",
    kind: "callApiStream",
    upstreamBackType: "BackChatInstructionStreamResult (stream chunks)",
    inputKeys: ["model", "instruction", "prefix?", "selected_text", "suffix?", "path?", "lang?", "blob_name?", "prefix_begin?", "suffix_end?", "blobs?", "chat_history?", "code_block?", "target_file_path?", "target_file_content?", "context_code_exchange_request_id?"],
    outputKeys: ["text (delta)", "replacement_text?", "replacement_old_text?", "replacement_start_line?", "replacement_end_line?"],
    byokImpl: "smart paste stream -> {text,+replacement meta}"
  },
  {
    endpoint: "/generate-commit-message-stream",
    kind: "callApiStream",
    upstreamBackType: "BackChatResult (stream chunks)",
    inputKeys: ["diff", "changed_file_stats?", "relevant_commit_messages?", "example_commit_messages?"],
    outputKeys: ["text (delta)", "unknown_blob_names[]", "checkpoint_not_found", "workspace_file_chunks[]", "nodes[]"],
    byokImpl: "commit msg stream -> BackChatResult"
  },
  {
    endpoint: "/generate-conversation-title",
    kind: "callApiStream",
    upstreamBackType: "BackChatResult (stream chunks)",
    inputKeys: ["chat_history", "conversation_id?", "model", "mode?", "nodes?(empty)"],
    outputKeys: ["text (title delta)", "unknown_blob_names[]", "checkpoint_not_found", "workspace_file_chunks[]", "nodes[] (first chunk only)"],
    byokImpl: "title stream -> BackChatResult"
  },
  {
    endpoint: "/next-edit-stream",
    kind: "callApiStream",
    upstreamBackType: "BackNextEditGenerationResult (single event)",
    inputKeys: ["model", "instruction", "prefix?", "selected_text?", "suffix?", "selection_begin_char?", "selection_end_char?", "path?", "blob_name?", "lang?", "blobs?", "recent_changes?", "diagnostics?", "blocked_locations?", "edit_events?", "mode?", "scope?", "api_version?", "sequence_id?"],
    outputKeys: ["unknown_blob_names[]", "checkpoint_not_found", "next_edit{suggestion_id,path,blob_name,char_start,char_end,existing_code,suggested_code,...}"],
    byokImpl: "provider.completeText -> BackNextEditGenerationResult(next_edit)"
  },
  {
    endpoint: "/next_edit_loc",
    kind: "callApi",
    upstreamBackType: "BackNextEditLocationResult",
    inputKeys: ["instruction", "path", "diagnostics?", "recent_changes?", "blobs?", "edit_events?", "vcs_change?", "num_results?", "is_single_file?"],
    outputKeys: ["candidate_locations[]", "unknown_blob_names[]", "checkpoint_not_found", "critical_errors[]"],
    byokImpl: "provider.completeText -> parse candidate_locations + diagnostics-first fallback"
  }
];

module.exports = { LLM_ENDPOINT_SPECS };
