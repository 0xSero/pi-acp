import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { logWarn } from "../logger";
import { PiEvent, PiResponse } from "../pi/types";
import type {
  ContentBlock,
  SessionUpdate,
  ToolCallContent,
  ToolKind,
  StopReason,
} from "@agentclientprotocol/sdk";
import { refreshSessionConfig, resolveModelId } from "./session-config";
import { THINKING_LEVELS, THINKING_LEVELS_WITH_XHIGH, XHIGH_MODELS } from "./session-consts";
import type { SessionState } from "./types";

export class SessionRuntime {
  private readonly sendUpdate: (sessionId: string, update: SessionUpdate) => void;

  constructor(options: { emitUpdate: (sessionId: string, update: SessionUpdate) => void }) {
    this.sendUpdate = options.emitUpdate;
  }

  handlePiLine(session: SessionState, line: PiEvent | PiResponse): void {
    if ((line as PiResponse).type === "response") {
      const response = line as PiResponse;
      if (!response.success) {
        logWarn(`pi response error: ${response.error ?? "unknown"}`);
      }
      return;
    }

    const event = line as PiEvent;
    switch (event.type) {
      case "message_update":
        this.handleMessageUpdate(session, event);
        break;
      case "tool_execution_start":
        void this.handleToolExecutionStart(session, event);
        break;
      case "tool_execution_update":
        this.handleToolExecutionUpdate(session, event);
        break;
      case "tool_execution_end":
        this.handleToolExecutionEnd(session, event);
        break;
      case "turn_end":
        this.handleTurnEnd(session, event);
        break;
      case "agent_end":
        if (session.pendingPrompt) {
          session.pendingPrompt.resolve("end_turn");
          session.pendingPrompt = undefined;
        }
        break;
      default:
        break;
    }
  }

  async handleSlashCommand(session: SessionState, prompt: ContentBlock[]): Promise<boolean> {
    const firstText = prompt.find((block) => block.type === "text") as { type: "text"; text: string } | undefined;
    if (!firstText) {
      return false;
    }

    const trimmed = firstText.text.trim();
    if (!trimmed.startsWith("/")) {
      return false;
    }

    const [commandRaw, ...rest] = trimmed.slice(1).split(/\s+/u);
    const command = commandRaw.toLowerCase();
    const args = rest.join(" ");
    const trimmedArgs = args.trim();

    switch (command) {
      case "compact": {
        const response = await session.pi.request({ type: "compact", customInstructions: trimmedArgs || undefined });
        const text = response.success ? "Compaction complete." : `Compaction failed: ${response.error ?? "unknown"}`;
        this.emitUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
        return true;
      }
      case "autocompact": {
        const normalized = trimmedArgs.toLowerCase();
        const enabled = normalized === "on" ? true : normalized === "off" ? false : undefined;
        if (enabled === undefined) {
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Usage: /autocompact on|off" },
          });
          return true;
        }
        const response = await session.pi.request({ type: "set_auto_compaction", enabled });
        const text = response.success
          ? `Auto compaction ${enabled ? "enabled" : "disabled"}.`
          : `Auto compaction failed: ${response.error ?? "unknown"}`;
        this.emitUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
        return true;
      }
      case "autoretry": {
        const normalized = trimmedArgs.toLowerCase();
        const enabled = normalized === "on" ? true : normalized === "off" ? false : undefined;
        if (enabled === undefined) {
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Usage: /autoretry on|off" },
          });
          return true;
        }
        const response = await session.pi.request({ type: "set_auto_retry", enabled });
        const text = response.success
          ? `Auto retry ${enabled ? "enabled" : "disabled"}.`
          : `Auto retry failed: ${response.error ?? "unknown"}`;
        this.emitUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
        return true;
      }
      case "export": {
        const response = await session.pi.request({ type: "export_html" });
        const pathValue =
          response.success && response.data && typeof response.data === "object"
            ? (response.data as { path?: string }).path
            : undefined;
        const text = response.success
          ? `Exported session to ${pathValue ?? "(unknown path)"}.`
          : `Export failed: ${response.error ?? "unknown"}`;
        this.emitUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
        return true;
      }
      case "session": {
        const response = await session.pi.request({ type: "get_session_stats" });
        if (!response.success) {
          const text = `Session stats failed: ${response.error ?? "unknown"}`;
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          });
          return true;
        }

        const data = response.data && typeof response.data === "object"
          ? (response.data as {
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
            })
          : {};

        const lines: string[] = ["Session stats:"];
        if (data.sessionId) {
          lines.push(`- ID: ${data.sessionId}`);
        }
        if (data.sessionFile) {
          lines.push(`- File: ${data.sessionFile}`);
        }
        const messageParts: string[] = [];
        if (typeof data.userMessages === "number") {
          messageParts.push(`user ${data.userMessages}`);
        }
        if (typeof data.assistantMessages === "number") {
          messageParts.push(`assistant ${data.assistantMessages}`);
        }
        if (typeof data.totalMessages === "number") {
          messageParts.push(`total ${data.totalMessages}`);
        }
        if (messageParts.length > 0) {
          lines.push(`- Messages: ${messageParts.join(", ")}`);
        }
        const toolParts: string[] = [];
        if (typeof data.toolCalls === "number") {
          toolParts.push(`calls ${data.toolCalls}`);
        }
        if (typeof data.toolResults === "number") {
          toolParts.push(`results ${data.toolResults}`);
        }
        if (toolParts.length > 0) {
          lines.push(`- Tools: ${toolParts.join(", ")}`);
        }
        const tokenParts: string[] = [];
        if (data.tokens) {
          if (typeof data.tokens.input === "number") {
            tokenParts.push(`input ${data.tokens.input.toLocaleString()}`);
          }
          if (typeof data.tokens.output === "number") {
            tokenParts.push(`output ${data.tokens.output.toLocaleString()}`);
          }
          if (typeof data.tokens.cacheRead === "number") {
            tokenParts.push(`cache read ${data.tokens.cacheRead.toLocaleString()}`);
          }
          if (typeof data.tokens.cacheWrite === "number") {
            tokenParts.push(`cache write ${data.tokens.cacheWrite.toLocaleString()}`);
          }
          if (typeof data.tokens.total === "number") {
            tokenParts.push(`total ${data.tokens.total.toLocaleString()}`);
          }
        }
        if (tokenParts.length > 0) {
          lines.push(`- Tokens: ${tokenParts.join(", ")}`);
        }
        if (typeof data.cost === "number") {
          lines.push(`- Cost: $${data.cost.toFixed(4)}`);
        }

        this.emitUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: lines.join("\n") },
        });
        return true;
      }
      case "model": {
        if (!trimmedArgs) {
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Usage: /model <provider>:<model-id>" },
          });
          return true;
        }
        const resolved = resolveModelId(session, trimmedArgs);
        if (!resolved) {
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Unknown model: ${trimmedArgs}` },
          });
          return true;
        }
        const response = await session.pi.request({
          type: "set_model",
          provider: resolved.provider,
          modelId: resolved.id,
        });
        if (!response.success) {
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: response.error ?? "Failed to set model." },
          });
          return true;
        }
        const { configOptions } = await refreshSessionConfig(session);
        this.emitUpdate(session.id, {
          sessionUpdate: "config_option_update",
          configOptions: configOptions ?? [],
        });
        this.emitUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Model set to ${resolved.provider}/${resolved.id}.` },
        });
        return true;
      }
      case "thinking": {
        const currentModel = session.currentModelId ? session.modelMap.get(session.currentModelId) ?? null : null;
        if (!currentModel?.reasoning) {
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Thinking levels are not available for the current model." },
          });
          return true;
        }
        const availableLevels = XHIGH_MODELS.has(currentModel.id) ? THINKING_LEVELS_WITH_XHIGH : THINKING_LEVELS;
        const normalizedArgs = trimmedArgs.toLowerCase();
        if (!trimmedArgs || normalizedArgs === "cycle" || normalizedArgs === "next") {
          const response = await session.pi.request({ type: "cycle_thinking_level" });
          if (!response.success) {
            this.emitUpdate(session.id, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: response.error ?? "Failed to cycle thinking level." },
            });
            return true;
          }
          const { configOptions } = await refreshSessionConfig(session);
          this.emitUpdate(session.id, {
            sessionUpdate: "config_option_update",
            configOptions: configOptions ?? [],
          });
          const levelLabel = session.thinkingLevel
            ? this.formatThinkingLevel(session.thinkingLevel)
            : "(unknown)";
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Thinking level set to ${levelLabel}.` },
          });
          return true;
        }
        const normalizedLevel = this.normalizeThinkingLevelInput(normalizedArgs, availableLevels);
        if (!normalizedLevel) {
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `Usage: /thinking <${availableLevels.join("|")}|cycle>`,
            },
          });
          return true;
        }
        const response = await session.pi.request({
          type: "set_thinking_level",
          level: normalizedLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
        });
        if (!response.success) {
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: response.error ?? "Failed to set thinking level." },
          });
          return true;
        }
        const { configOptions } = await refreshSessionConfig(session);
        this.emitUpdate(session.id, {
          sessionUpdate: "config_option_update",
          configOptions: configOptions ?? [],
        });
        this.emitUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Thinking level set to ${this.formatThinkingLevel(normalizedLevel)}.` },
        });
        return true;
      }
      case "cycle-model": {
        const response = await session.pi.request({ type: "cycle_model" });
        if (!response.success) {
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: response.error ?? "Failed to cycle model." },
          });
          return true;
        }
        const data = response.data as { model?: { provider?: string; id?: string } } | null;
        const modelLabel = data?.model?.provider && data.model.id
          ? `${data.model.provider}/${data.model.id}`
          : "(unknown model)";
        const { configOptions } = await refreshSessionConfig(session);
        this.emitUpdate(session.id, {
          sessionUpdate: "config_option_update",
          configOptions: configOptions ?? [],
        });
        this.emitUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Model set to ${modelLabel}.` },
        });
        return true;
      }
      case "bash": {
        if (!trimmedArgs) {
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Usage: /bash <command>" },
          });
          return true;
        }
        const response = await session.pi.request({ type: "bash", command: trimmedArgs });
        if (!response.success) {
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: response.error ?? "Bash command failed." },
          });
          return true;
        }
        const data = response.data as {
          output?: string;
          exitCode?: number | null;
          cancelled?: boolean;
          truncated?: boolean;
          fullOutputPath?: string;
        };
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
        this.emitUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `${output}${footer}` },
        });
        return true;
      }
      case "steer": {
        if (!trimmedArgs) {
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Usage: /steer <message>" },
          });
          return true;
        }
        const response = await session.pi.request({ type: "steer", message: trimmedArgs });
        const text = response.success ? "Steering message queued." : `Steer failed: ${response.error ?? "unknown"}`;
        this.emitUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
        return true;
      }
      case "queue": {
        if (!trimmedArgs) {
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Usage: /queue <message>" },
          });
          return true;
        }
        const response = await session.pi.request({ type: "follow_up", message: trimmedArgs });
        const text = response.success ? "Follow-up message queued." : `Queue failed: ${response.error ?? "unknown"}`;
        this.emitUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
        return true;
      }
      case "last": {
        const response = await session.pi.request({ type: "get_last_assistant_text" });
        if (!response.success) {
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: response.error ?? "Failed to fetch last message." },
          });
          return true;
        }
        const textValue = response.data && typeof response.data === "object"
          ? (response.data as { text?: string | null }).text
          : null;
        const text = textValue ?? "(no assistant message yet)";
        this.emitUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
        return true;
      }
      case "fork": {
        let entryId = trimmedArgs;
        if (!entryId) {
          const messagesResponse = await session.pi.request({ type: "get_fork_messages" });
          if (!messagesResponse.success) {
            this.emitUpdate(session.id, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: messagesResponse.error ?? "Failed to load fork messages." },
            });
            return true;
          }
          const messages = (messagesResponse.data as { messages?: { entryId: string; text: string }[] } | null)?.messages;
          if (!messages || messages.length === 0) {
            this.emitUpdate(session.id, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "No user messages available to fork from." },
            });
            return true;
          }
          entryId = messages[messages.length - 1].entryId;
        }

        const response = await session.pi.request({ type: "fork", entryId });
        if (!response.success) {
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: response.error ?? "Failed to fork session." },
          });
          return true;
        }
        const data = response.data as { text?: string; cancelled?: boolean } | null;
        const { configOptions } = await refreshSessionConfig(session);
        this.emitUpdate(session.id, {
          sessionUpdate: "config_option_update",
          configOptions: configOptions ?? [],
        });
        if (data?.cancelled) {
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Fork cancelled." },
          });
          return true;
        }
        const snippet = data?.text ? data.text.replace(/\s+/g, " ").trim().slice(0, 160) : "";
        const suffix = snippet ? `\nFrom: ${snippet}${data?.text && data.text.length > 160 ? "…" : ""}` : "";
        this.emitUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Forked session.${suffix}` },
        });
        return true;
      }
      case "new": {
        const response = await session.pi.request({ type: "new_session" });
        if (!response.success) {
          this.emitUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: response.error ?? "Failed to start new session." },
          });
          return true;
        }
        const data = response.data as { cancelled?: boolean } | null;
        const { configOptions } = await refreshSessionConfig(session);
        this.emitUpdate(session.id, {
          sessionUpdate: "config_option_update",
          configOptions: configOptions ?? [],
        });
        const text = data?.cancelled ? "New session cancelled." : "New session started.";
        this.emitUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
        return true;
      }
      default:
        return false;
    }
  }

  buildPrompt(prompt: ContentBlock[]): {
    message: string;
    images: { type: "image"; source: { type: "base64"; mediaType: string; data: string } }[];
  } {
    const images: { type: "image"; source: { type: "base64"; mediaType: string; data: string } }[] = [];
    const message = prompt
      .map((block) => {
        if (block.type === "text") {
          return block.text;
        }
        if (block.type === "resource") {
          const resource = block.resource;
          const text = "text" in resource ? resource.text : "";
          const uri = "uri" in resource ? resource.uri : "";
          return `\n[resource:${uri}]\n${text}`;
        }
        if (block.type === "resource_link") {
          return `\n[resource_link:${block.uri}] ${block.name}`;
        }
        if (block.type === "image") {
          images.push({
            type: "image",
            source: {
              type: "base64",
              mediaType: block.mimeType,
              data: block.data,
            },
          });
          return "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");

    return { message, images };
  }

  async replayHistory(session: SessionState): Promise<void> {
    const response = await session.pi.request({ type: "get_messages" });
    if (!response.success || !response.data || typeof response.data !== "object") {
      return;
    }
    const messages = (response.data as { messages?: unknown[] }).messages;
    if (!Array.isArray(messages)) {
      return;
    }

    for (const message of messages) {
      const entry = message as { role?: string; content?: unknown };
      const role = entry.role ?? "assistant";
      const content = entry.content;

      if (typeof content === "string") {
        this.emitUpdate(session.id, {
          sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
          content: { type: "text", text: content },
        });
        continue;
      }

      if (Array.isArray(content)) {
        for (const item of content) {
          if (typeof item === "object" && item && (item as { type?: string }).type === "text") {
            const text = (item as { text?: string }).text;
            if (text) {
              this.emitUpdate(session.id, {
                sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
                content: { type: "text", text },
              });
            }
          }
        }
      }
    }
  }

  private handleMessageUpdate(session: SessionState, event: Extract<PiEvent, { type: "message_update" }>): void {
    const assistantEvent = event.assistantMessageEvent;
    if (!assistantEvent) {
      return;
    }

    if (assistantEvent.type === "text_delta") {
      this.emitUpdate(session.id, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: assistantEvent.delta },
      });
      return;
    }

    if (assistantEvent.type === "thinking_delta") {
      this.emitUpdate(session.id, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: assistantEvent.delta },
      });
    }
  }

  private async handleToolExecutionStart(
    session: SessionState,
    event: Extract<PiEvent, { type: "tool_execution_start" }>
  ): Promise<void> {
    this.emitUpdate(session.id, {
      sessionUpdate: "tool_call",
      toolCallId: event.toolCallId,
      title: event.toolName,
      kind: this.mapToolKind(event.toolName),
      status: "pending",
      rawInput: event.args,
    });

    const path = this.extractPathFromArgs(event.args);
    if (path) {
      await this.snapshotFile(session, event.toolCallId, path);
    }
  }

  private handleToolExecutionUpdate(
    session: SessionState,
    event: Extract<PiEvent, { type: "tool_execution_update" }>
  ): void {
    const contentText = this.extractToolContent(event.partialResult);
    this.emitUpdate(session.id, {
      sessionUpdate: "tool_call_update",
      toolCallId: event.toolCallId,
      status: "in_progress",
      content: contentText ? [{ type: "content", content: { type: "text", text: contentText } }] : undefined,
    });
  }

  private handleToolExecutionEnd(
    session: SessionState,
    event: Extract<PiEvent, { type: "tool_execution_end" }>
  ): void {
    const contentText = this.extractToolContent(event.result);
    const diffContent = this.buildDiffContent(session, event.toolCallId);
    const content: ToolCallContent[] = [
      ...(contentText ? [{ type: "content" as const, content: { type: "text" as const, text: contentText } }] : []),
      ...(diffContent ? [diffContent] : []),
    ];

    this.emitUpdate(session.id, {
      sessionUpdate: "tool_call_update",
      toolCallId: event.toolCallId,
      status: event.isError ? "failed" : "completed",
      content: content.length > 0 ? content : undefined,
      rawOutput: event.result,
    });
  }

  private handleTurnEnd(session: SessionState, event: Extract<PiEvent, { type: "turn_end" }>): void {
    if (!session.pendingPrompt) {
      return;
    }
    const stopReason = this.mapStopReason((event.message as { stopReason?: string } | undefined)?.stopReason);
    session.pendingPrompt.resolve(stopReason);
    session.pendingPrompt = undefined;
  }

  private emitUpdate(sessionId: string, update: SessionUpdate): void {
    this.sendUpdate(sessionId, update);
  }

  private extractToolContent(result?: { content?: { type: "text"; text: string }[] }): string | undefined {
    if (!result?.content) {
      return undefined;
    }
    return result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
  }

  private extractPathFromArgs(args: unknown): string | undefined {
    if (!args || typeof args !== "object") {
      return undefined;
    }
    const candidate = args as { path?: unknown; filePath?: unknown; file?: unknown };
    const path = [candidate.path, candidate.filePath, candidate.file].find((value) => typeof value === "string");
    return typeof path === "string" ? path : undefined;
  }

  private async snapshotFile(session: SessionState, toolCallId: string, path: string): Promise<void> {
    if (!path.startsWith("/")) {
      return;
    }
    try {
      const oldText = await readFile(path, "utf8");
      session.toolCallSnapshots.set(toolCallId, { path, oldText });
    } catch (error) {
      logWarn(`snapshot failed for ${path}: ${(error as Error).message}`);
    }
  }

  private buildDiffContent(
    session: SessionState,
    toolCallId: string
  ): { type: "diff"; path: string; oldText?: string | null; newText: string } | null {
    const snapshot = session.toolCallSnapshots.get(toolCallId);
    if (!snapshot) {
      return null;
    }
    session.toolCallSnapshots.delete(toolCallId);
    const newText = this.readTextFileSync(snapshot.path);
    if (newText === null) {
      return null;
    }
    if (snapshot.oldText === newText) {
      return null;
    }
    return {
      type: "diff",
      path: snapshot.path,
      oldText: snapshot.oldText,
      newText,
    };
  }

  private readTextFileSync(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      logWarn(`read failed for ${path}: ${(error as Error).message}`);
      return null;
    }
  }

  private normalizeThinkingLevelInput(value: string, availableLevels: readonly string[]): string | null {
    const normalized = value.toLowerCase();
    const mapped = normalized === "extra-high" || normalized === "extra" ? "xhigh" : normalized;
    return availableLevels.includes(mapped) ? mapped : null;
  }

  private formatThinkingLevel(level: string): string {
    if (level === "xhigh") {
      return "Extra High";
    }
    return level.charAt(0).toUpperCase() + level.slice(1);
  }

  private mapToolKind(toolName: string): ToolKind {
    const normalized = toolName.toLowerCase();
    if (normalized.includes("read")) {
      return "read";
    }
    if (normalized.includes("edit")) {
      return "edit";
    }
    if (normalized.includes("search")) {
      return "search";
    }
    if (normalized.includes("delete")) {
      return "delete";
    }
    if (normalized.includes("bash") || normalized.includes("exec")) {
      return "execute";
    }
    return "other";
  }

  private mapStopReason(reason?: string): StopReason {
    switch (reason) {
      case "stop":
        return "end_turn";
      case "length":
        return "max_tokens";
      case "aborted":
        return "cancelled";
      case "toolUse":
        return "end_turn";
      default:
        return "end_turn";
    }
  }
}
