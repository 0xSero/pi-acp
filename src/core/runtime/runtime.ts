import { logWarn } from "../../logger";
import { PiEvent, PiResponse } from "../../pi/types";
import type { ContentBlock, SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import type { SessionState } from "../session/types";
import { SessionCommandHandler } from "../commands/handler";
import { SessionToolHandler } from "../tools/session-tools";
import { SessionStatsReporter } from "./stats";

const STOP_REASON_MAP: Record<string, StopReason> = {
  stop: "end_turn",
  length: "max_tokens",
  aborted: "cancelled",
  toolUse: "end_turn",
};

const HISTORY_LOAD_TIMEOUT_MS = 30000;

export class SessionRuntime {
  private readonly emitUpdate: (sessionId: string, update: SessionUpdate) => void;
  private readonly commands: SessionCommandHandler;
  private readonly tools: SessionToolHandler;
  private readonly stats: SessionStatsReporter;

  constructor(options: { emitUpdate: (sessionId: string, update: SessionUpdate) => void }) {
    this.emitUpdate = options.emitUpdate;
    this.commands = new SessionCommandHandler(this.emitUpdate);
    this.tools = new SessionToolHandler(this.emitUpdate);
    this.stats = new SessionStatsReporter(this.emitUpdate);
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
        void this.tools.handleStart(session, event);
        break;
      case "tool_execution_update":
        this.tools.handleUpdate(session, event);
        break;
      case "tool_execution_end":
        this.tools.handleEnd(session, event);
        break;
      case "turn_end":
        this.handleTurnEnd(session, event);
        break;
      case "agent_end":
        this.resolvePendingPrompt(session, "end_turn");
        break;
      default:
        break;
    }
  }

  handleSlashCommand(session: SessionState, prompt: ContentBlock[]): Promise<boolean> {
    return this.commands.handleSlashCommand(session, prompt);
  }

  buildPrompt(prompt: ContentBlock[]): {
    message: string;
    images: { type: "image"; source: { type: "base64"; mediaType: string; data: string } }[];
  } {
    const images: { type: "image"; source: { type: "base64"; mediaType: string; data: string } }[] = [];
    const message = prompt
      .map((block) => {
        switch (block.type) {
          case "text":
            return block.text;
          case "resource": {
            const resource = block.resource;
            const text = "text" in resource ? resource.text : "";
            const uri = "uri" in resource ? resource.uri : "";
            return `\n[resource:${uri}]\n${text}`;
          }
          case "resource_link":
            return `\n[resource_link:${block.uri}] ${block.name}`;
          case "image":
            images.push({
              type: "image",
              source: {
                type: "base64",
                mediaType: block.mimeType,
                data: block.data,
              },
            });
            return "";
          default:
            return "";
        }
      })
      .filter(Boolean)
      .join("\n");

    return { message, images };
  }

  async replayHistory(session: SessionState): Promise<void> {
    let response: PiResponse;
    try {
      response = await session.pi.request({ type: "get_messages" }, HISTORY_LOAD_TIMEOUT_MS);
    } catch (error) {
      logWarn(`history replay failed for ${session.id}: ${(error as Error).message}`);
      return;
    }
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
        this.emitText(session.id, role === "user" ? "user_message_chunk" : "agent_message_chunk", content);
        continue;
      }

      if (Array.isArray(content)) {
        for (const item of content) {
          if (typeof item === "object" && item && (item as { type?: string }).type === "text") {
            const text = (item as { text?: string }).text;
            if (text) {
              this.emitText(session.id, role === "user" ? "user_message_chunk" : "agent_message_chunk", text);
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
      this.emitText(session.id, "agent_message_chunk", assistantEvent.delta);
      return;
    }

    if (assistantEvent.type === "thinking_delta") {
      this.emitText(session.id, "agent_thought_chunk", assistantEvent.delta);
    }
  }

  private handleTurnEnd(session: SessionState, event: Extract<PiEvent, { type: "turn_end" }>): void {
    const stopReason = this.mapStopReason((event.message as { stopReason?: string } | undefined)?.stopReason);
    if (session.pendingPrompt) {
      this.resolvePendingPrompt(session, stopReason);
    }
    void this.stats.report(session);
  }

  private resolvePendingPrompt(session: SessionState, stopReason: StopReason): void {
    if (session.pendingPrompt) {
      session.pendingPrompt.resolve(stopReason);
      session.pendingPrompt = undefined;
    }
  }

  private emitText(
    sessionId: string,
    sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk",
    text: string
  ): void {
    this.emitUpdate(sessionId, {
      sessionUpdate,
      content: { type: "text", text },
    });
  }

  private mapStopReason(reason?: string): StopReason {
    return (reason ? STOP_REASON_MAP[reason] : undefined) ?? "end_turn";
  }
}
