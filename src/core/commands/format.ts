import type { SessionState } from "../session/types";

export type SessionStats = {
  sessionId?: string;
  sessionFile?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  toolResults?: number;
  totalMessages?: number;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
};

export type BashResult = {
  output?: string;
  exitCode?: number | null;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
};

export function formatSessionStats(data: SessionStats): string {
  const lines = ["Session stats:"];
  if (data.sessionId) {
    lines.push(`- ID: ${data.sessionId}`);
  }
  if (data.sessionFile) {
    lines.push(`- File: ${data.sessionFile}`);
  }
  pushSection(lines, "Messages", [
    formatCount("user", data.userMessages),
    formatCount("assistant", data.assistantMessages),
    formatCount("total", data.totalMessages),
  ]);
  pushSection(lines, "Tools", [formatCount("calls", data.toolCalls), formatCount("results", data.toolResults)]);
  if (data.tokens) {
    pushSection(lines, "Tokens", [
      formatCount("input", data.tokens.input, true),
      formatCount("output", data.tokens.output, true),
      formatCount("cache read", data.tokens.cacheRead, true),
      formatCount("cache write", data.tokens.cacheWrite, true),
      formatCount("total", data.tokens.total, true),
    ]);
  }
  if (typeof data.cost === "number") {
    lines.push(`- Cost: $${data.cost.toFixed(4)}`);
  }
  return lines.join("\n");
}

export function formatBashResult(data: BashResult): string {
  const output = data.output && data.output.trim().length > 0 ? data.output : "(no output)";
  const details: string[] = [];
  if (typeof data.exitCode === "number") {
    details.push(`exit ${data.exitCode}`);
  }
  if (data.cancelled) {
    details.push("cancelled");
  }
  if (data.truncated) {
    details.push("truncated");
  }
  if (data.fullOutputPath) {
    details.push(`full output: ${data.fullOutputPath}`);
  }
  const footer = details.length > 0 ? `\n\n(${details.join(", ")})` : "";
  return `${output}${footer}`;
}

function formatCount(label: string, value?: number, useLocale = false): string | null {
  if (typeof value !== "number") {
    return null;
  }
  const formatted = useLocale ? value.toLocaleString() : String(value);
  return `${label} ${formatted}`;
}

function pushSection(lines: string[], label: string, parts: Array<string | null>): void {
  const filtered = parts.filter((part): part is string => Boolean(part));
  if (filtered.length > 0) {
    lines.push(`- ${label}: ${filtered.join(", ")}`);
  }
}

export async function resolveForkEntryId(
  session: SessionState,
  sendText: (session: SessionState, text: string) => void
): Promise<string | null> {
  const messagesResponse = await session.pi.request({ type: "get_fork_messages" });
  if (!messagesResponse.success) {
    sendText(session, messagesResponse.error ?? "Failed to load fork messages.");
    return null;
  }
  const messages = (messagesResponse.data as { messages?: { entryId: string; text: string }[] } | null)?.messages;
  if (!messages || messages.length === 0) {
    sendText(session, "No user messages available to fork from.");
    return null;
  }
  return messages[messages.length - 1].entryId;
}
