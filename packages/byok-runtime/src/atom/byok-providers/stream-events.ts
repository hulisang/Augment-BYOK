export type ByokStreamEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; summary: string }
  | { kind: "tool_use"; toolUseId: string; toolName: string; inputJson: string };
