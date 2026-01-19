import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";
import { formatThinkingLevel, refreshSessionConfig, resolveModelId } from "./session-config";
import { THINKING_LEVELS, THINKING_LEVELS_WITH_XHIGH, XHIGH_MODELS } from "./session-consts";
import type { SessionState } from "./types";

type EmitUpdate = (sessionId: string, update: SessionUpdate) => void;

type SessionStats = {
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

type BashResult = {
  output?: string;
  exitCode?: number | null;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
};

export class SessionCommandHandler {
  private readonly emitUpdate: EmitUpdate;

  constructor(emitUpdate: EmitUpdate) {
    this.emitUpdate = emitUpdate;
  }

  async handleSlashCommand(session: SessionState, prompt: ContentBlock[]): Promise<boolean> {
    const commandText = this.extractCommandText(prompt);
    if (!commandText) {
      return false;
    }
    const parsed = this.parseCommand(commandText);
    if (!parsed) {
      return false;
    }

    const { command, args } = parsed;
    switch (command) {
      case "compact":
        await this.handleCompact(session, args);
        return true;
      case "autocompact":
        await this.handleToggle(session, args, {
          usage: "/autocompact on|off",
          requestType: "set_auto_compaction",
          successLabel: "Auto compaction",
          failureLabel: "Auto compaction",
        });
        return true;
      case "autoretry":
        await this.handleToggle(session, args, {
          usage: "/autoretry on|off",
          requestType: "set_auto_retry",
          successLabel: "Auto retry",
          failureLabel: "Auto retry",
        });
        return true;
      case "export":
        await this.handleExport(session);
        return true;
      case "session":
        await this.handleSessionStats(session);
        return true;
      case "model":
        await this.handleModel(session, args);
        return true;
      case "thinking":
        await this.handleThinking(session, args);
        return true;
      case "cycle-model":
        await this.handleCycleModel(session);
        return true;
      case "bash":
        await this.handleBash(session, args);
        return true;
      case "steer":
        await this.handleSteer(session, args);
        return true;
      case "queue":
        await this.handleQueue(session, args);
        return true;
      case "last":
        await this.handleLast(session);
        return true;
      case "fork":
        await this.handleFork(session, args);
        return true;
      case "new":
        await this.handleNewSession(session);
        return true;
      default:
        return false;
    }
  }

  private extractCommandText(prompt: ContentBlock[]): string | null {
    const firstText = prompt.find((block): block is { type: "text"; text: string } => block.type === "text");
    if (!firstText) {
      return null;
    }
    const trimmed = firstText.text.trim();
    return trimmed.startsWith("/") ? trimmed : null;
  }

  private parseCommand(text: string): { command: string; args: string } | null {
    const [commandRaw, ...rest] = text.slice(1).split(/\s+/u);
    if (!commandRaw) {
      return null;
    }
    return { command: commandRaw.toLowerCase(), args: rest.join(" ").trim() };
  }

  private sendText(session: SessionState, text: string): void {
    this.emitUpdate(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });
  }

  private async refreshConfigOptions(session: SessionState): Promise<void> {
    const { configOptions } = await refreshSessionConfig(session);
    this.emitUpdate(session.id, {
      sessionUpdate: "config_option_update",
      configOptions: configOptions ?? [],
    });
  }

  private async handleCompact(session: SessionState, args: string): Promise<void> {
    const response = await session.pi.request({
      type: "compact",
      customInstructions: args || undefined,
    });
    const text = response.success ? "Compaction complete." : `Compaction failed: ${response.error ?? "unknown"}`;
    this.sendText(session, text);
  }

  private async handleToggle(
    session: SessionState,
    args: string,
    options: {
      usage: string;
      requestType: "set_auto_compaction" | "set_auto_retry";
      successLabel: string;
      failureLabel: string;
    }
  ): Promise<void> {
    const enabled = this.parseOnOff(args);
    if (enabled === null) {
      this.sendText(session, `Usage: ${options.usage}`);
      return;
    }
    const response = await session.pi.request({ type: options.requestType, enabled });
    const text = response.success
      ? `${options.successLabel} ${enabled ? "enabled" : "disabled"}.`
      : `${options.failureLabel} failed: ${response.error ?? "unknown"}`;
    this.sendText(session, text);
  }

  private parseOnOff(value: string): boolean | null {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (normalized === "on") {
      return true;
    }
    if (normalized === "off") {
      return false;
    }
    return null;
  }

  private async handleExport(session: SessionState): Promise<void> {
    const response = await session.pi.request({ type: "export_html" });
    const pathValue =
      response.success && response.data && typeof response.data === "object"
        ? (response.data as { path?: string }).path
        : undefined;
    const text = response.success
      ? `Exported session to ${pathValue ?? "(unknown path)"}.`
      : `Export failed: ${response.error ?? "unknown"}`;
    this.sendText(session, text);
  }

  private async handleSessionStats(session: SessionState): Promise<void> {
    const response = await session.pi.request({ type: "get_session_stats" });
    if (!response.success) {
      this.sendText(session, `Session stats failed: ${response.error ?? "unknown"}`);
      return;
    }
    const data = response.data && typeof response.data === "object" ? (response.data as SessionStats) : {};
    this.sendText(session, this.formatSessionStats(data));
  }

  private formatSessionStats(data: SessionStats): string {
    const lines = ["Session stats:"];
    if (data.sessionId) {
      lines.push(`- ID: ${data.sessionId}`);
    }
    if (data.sessionFile) {
      lines.push(`- File: ${data.sessionFile}`);
    }

    this.pushSection(lines, "Messages", [
      this.formatCount("user", data.userMessages),
      this.formatCount("assistant", data.assistantMessages),
      this.formatCount("total", data.totalMessages),
    ]);

    this.pushSection(lines, "Tools", [
      this.formatCount("calls", data.toolCalls),
      this.formatCount("results", data.toolResults),
    ]);

    if (data.tokens) {
      this.pushSection(lines, "Tokens", [
        this.formatCount("input", data.tokens.input, true),
        this.formatCount("output", data.tokens.output, true),
        this.formatCount("cache read", data.tokens.cacheRead, true),
        this.formatCount("cache write", data.tokens.cacheWrite, true),
        this.formatCount("total", data.tokens.total, true),
      ]);
    }

    if (typeof data.cost === "number") {
      lines.push(`- Cost: $${data.cost.toFixed(4)}`);
    }

    return lines.join("\n");
  }

  private formatCount(label: string, value?: number, useLocale = false): string | null {
    if (typeof value !== "number") {
      return null;
    }
    const formatted = useLocale ? value.toLocaleString() : String(value);
    return `${label} ${formatted}`;
  }

  private pushSection(lines: string[], label: string, parts: Array<string | null>): void {
    const filtered = parts.filter((part): part is string => Boolean(part));
    if (filtered.length > 0) {
      lines.push(`- ${label}: ${filtered.join(", ")}`);
    }
  }

  private async handleModel(session: SessionState, args: string): Promise<void> {
    if (!args) {
      this.sendText(session, "Usage: /model <provider>:<model-id>");
      return;
    }
    const resolved = resolveModelId(session, args);
    if (!resolved) {
      this.sendText(session, `Unknown model: ${args}`);
      return;
    }
    const response = await session.pi.request({
      type: "set_model",
      provider: resolved.provider,
      modelId: resolved.id,
    });
    if (!response.success) {
      this.sendText(session, response.error ?? "Failed to set model.");
      return;
    }
    await this.refreshConfigOptions(session);
    this.sendText(session, `Model set to ${resolved.provider}/${resolved.id}.`);
  }

  private async handleThinking(session: SessionState, args: string): Promise<void> {
    const currentModel = session.currentModelId ? session.modelMap.get(session.currentModelId) ?? null : null;
    if (!currentModel?.reasoning) {
      this.sendText(session, "Thinking levels are not available for the current model.");
      return;
    }
    const levels = XHIGH_MODELS.has(currentModel.id) ? THINKING_LEVELS_WITH_XHIGH : THINKING_LEVELS;
    const normalizedArgs = args.toLowerCase();
    if (!args || normalizedArgs === "cycle" || normalizedArgs === "next") {
      const response = await session.pi.request({ type: "cycle_thinking_level" });
      if (!response.success) {
        this.sendText(session, response.error ?? "Failed to cycle thinking level.");
        return;
      }
      await this.refreshConfigOptions(session);
      const levelLabel = session.thinkingLevel ? formatThinkingLevel(session.thinkingLevel) : "(unknown)";
      this.sendText(session, `Thinking level set to ${levelLabel}.`);
      return;
    }

    const normalizedLevel = this.normalizeThinkingLevelInput(normalizedArgs, levels);
    if (!normalizedLevel) {
      this.sendText(session, `Usage: /thinking <${levels.join("|")}|cycle>`);
      return;
    }
    const response = await session.pi.request({
      type: "set_thinking_level",
      level: normalizedLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
    });
    if (!response.success) {
      this.sendText(session, response.error ?? "Failed to set thinking level.");
      return;
    }
    await this.refreshConfigOptions(session);
    this.sendText(session, `Thinking level set to ${formatThinkingLevel(normalizedLevel)}.`);
  }

  private normalizeThinkingLevelInput(value: string, levels: readonly string[]): string | null {
    const mapped = value === "extra-high" || value === "extra" ? "xhigh" : value;
    return levels.includes(mapped) ? mapped : null;
  }

  private async handleCycleModel(session: SessionState): Promise<void> {
    const response = await session.pi.request({ type: "cycle_model" });
    if (!response.success) {
      this.sendText(session, response.error ?? "Failed to cycle model.");
      return;
    }
    const data = response.data as { model?: { provider?: string; id?: string } } | null;
    const modelLabel =
      data?.model?.provider && data.model.id
        ? `${data.model.provider}/${data.model.id}`
        : "(unknown model)";
    await this.refreshConfigOptions(session);
    this.sendText(session, `Model set to ${modelLabel}.`);
  }

  private async handleBash(session: SessionState, args: string): Promise<void> {
    if (!args) {
      this.sendText(session, "Usage: /bash <command>");
      return;
    }
    const response = await session.pi.request({ type: "bash", command: args });
    if (!response.success) {
      this.sendText(session, response.error ?? "Bash command failed.");
      return;
    }
    const data = response.data as BashResult;
    this.sendText(session, this.formatBashResult(data));
  }

  private formatBashResult(data: BashResult): string {
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

  private async handleSteer(session: SessionState, args: string): Promise<void> {
    if (!args) {
      this.sendText(session, "Usage: /steer <message>");
      return;
    }
    const response = await session.pi.request({ type: "steer", message: args });
    const text = response.success ? "Steering message queued." : `Steer failed: ${response.error ?? "unknown"}`;
    this.sendText(session, text);
  }

  private async handleQueue(session: SessionState, args: string): Promise<void> {
    if (!args) {
      this.sendText(session, "Usage: /queue <message>");
      return;
    }
    const response = await session.pi.request({ type: "follow_up", message: args });
    const text = response.success ? "Follow-up message queued." : `Queue failed: ${response.error ?? "unknown"}`;
    this.sendText(session, text);
  }

  private async handleLast(session: SessionState): Promise<void> {
    const response = await session.pi.request({ type: "get_last_assistant_text" });
    if (!response.success) {
      this.sendText(session, response.error ?? "Failed to fetch last message.");
      return;
    }
    const textValue = response.data && typeof response.data === "object"
      ? (response.data as { text?: string | null }).text
      : null;
    this.sendText(session, textValue ?? "(no assistant message yet)");
  }

  private async handleFork(session: SessionState, args: string): Promise<void> {
    let entryId: string | null = args || null;
    if (!entryId) {
      entryId = await this.resolveForkEntryId(session);
      if (!entryId) {
        return;
      }
    }

    const response = await session.pi.request({ type: "fork", entryId });
    if (!response.success) {
      this.sendText(session, response.error ?? "Failed to fork session.");
      return;
    }
    const data = response.data as { text?: string; cancelled?: boolean } | null;
    await this.refreshConfigOptions(session);
    if (data?.cancelled) {
      this.sendText(session, "Fork cancelled.");
      return;
    }
    const snippet = data?.text ? data.text.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    const suffix = snippet ? `\nFrom: ${snippet}${data?.text && data.text.length > 160 ? "…" : ""}` : "";
    this.sendText(session, `Forked session.${suffix}`);
  }

  private async resolveForkEntryId(session: SessionState): Promise<string | null> {
    const messagesResponse = await session.pi.request({ type: "get_fork_messages" });
    if (!messagesResponse.success) {
      this.sendText(session, messagesResponse.error ?? "Failed to load fork messages.");
      return null;
    }
    const messages = (messagesResponse.data as { messages?: { entryId: string; text: string }[] } | null)?.messages;
    if (!messages || messages.length === 0) {
      this.sendText(session, "No user messages available to fork from.");
      return null;
    }
    return messages[messages.length - 1].entryId;
  }

  private async handleNewSession(session: SessionState): Promise<void> {
    const response = await session.pi.request({ type: "new_session" });
    if (!response.success) {
      this.sendText(session, response.error ?? "Failed to start new session.");
      return;
    }
    const data = response.data as { cancelled?: boolean } | null;
    await this.refreshConfigOptions(session);
    const text = data?.cancelled ? "New session cancelled." : "New session started.";
    this.sendText(session, text);
  }
}
