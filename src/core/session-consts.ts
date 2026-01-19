export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
export const THINKING_LEVELS_WITH_XHIGH = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export const XHIGH_MODELS = new Set(["gpt-5.1-codex-max", "gpt-5.2", "gpt-5.2-codex"]);

export const DEFAULT_COMMANDS = [
  {
    name: "compact",
    description: "Compact conversation",
    input: { hint: "optional instructions" },
  },
  { name: "autocompact", description: "Toggle auto compaction (on|off)" },
  { name: "autoretry", description: "Toggle auto retry (on|off)" },
  { name: "export", description: "Export session to HTML" },
  { name: "session", description: "Show session stats" },
  {
    name: "model",
    description: "Switch model",
    input: { hint: "provider:model-id" },
  },
  {
    name: "thinking",
    description: "Set or cycle thinking level",
    input: { hint: "level (off|minimal|low|medium|high|xhigh) or cycle" },
  },
  { name: "cycle-model", description: "Cycle to the next model" },
  {
    name: "bash",
    description: "Run a shell command",
    input: { hint: "command" },
  },
  {
    name: "steer",
    description: "Send a steering message",
    input: { hint: "message" },
  },
  {
    name: "queue",
    description: "Queue a follow-up message",
    input: { hint: "message" },
  },
  { name: "last", description: "Show last assistant message" },
  {
    name: "fork",
    description: "Fork from a message",
    input: { hint: "entryId (optional)" },
  },
  { name: "new", description: "Start a fresh session" },
];
