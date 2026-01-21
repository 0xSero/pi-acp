import type { SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";
import { logWarn } from "../../logger";
import type { PiResponse } from "../../pi/types";
import { readSessionInfo, type SessionFileInfo } from "../session/metadata";
import type { SessionState } from "../session/types";

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

type EmitUpdate = (sessionId: string, update: SessionUpdate) => void;

const PI_REQUEST_TIMEOUT_MS = 15000;

export class SessionStatsReporter {
  private readonly emitUpdate: EmitUpdate;
  private readonly seen = new Set<string>();

  constructor(emitUpdate: EmitUpdate) {
    this.emitUpdate = emitUpdate;
  }

  async report(session: SessionState): Promise<void> {
    let statsResponse: PiResponse;
    try {
      statsResponse = await session.pi.request({ type: "get_session_stats" }, PI_REQUEST_TIMEOUT_MS);
    } catch (error) {
      logWarn(`session stats request failed for ${session.id}: ${(error as Error).message}`);
      return;
    }
    if (!statsResponse.success) {
      return;
    }
    const data = statsResponse.data && typeof statsResponse.data === "object" ? (statsResponse.data as SessionStats) : {};
    const model = session.currentModelId ? session.modelMap.get(session.currentModelId) : undefined;
    const contentText = this.formatStats(data, model?.contextWindow, model?.maxTokens);
    const sessionInfo = await this.loadSessionInfo(session);

    const toolCallId = `session_stats:${session.id}`;
    if (!this.seen.has(session.id)) {
      this.seen.add(session.id);
      this.emitUpdate(session.id, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Session stats",
        kind: "other",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: contentText } }],
      });
    } else {
      const content: ToolCallContent[] = [{ type: "content", content: { type: "text", text: contentText } }];
      this.emitUpdate(session.id, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content,
      });
    }

    const infoUpdate: SessionUpdate = {
      sessionUpdate: "session_info_update",
      _meta: {
        tokenStats: {
          tokens: data.tokens ?? {},
          contextWindow: model?.contextWindow ?? null,
          maxTokens: model?.maxTokens ?? null,
          cost: data.cost ?? null,
        },
        messageCount: sessionInfo?.messageCount ?? null,
        sessionFile: sessionInfo?.filePath ?? session.sessionFile ?? null,
      },
    };

    if (sessionInfo?.title !== undefined) {
      infoUpdate.title = sessionInfo.title;
    }
    if (sessionInfo?.updatedAt !== undefined) {
      infoUpdate.updatedAt = sessionInfo.updatedAt;
    }

    this.emitUpdate(session.id, infoUpdate);
  }

  private async loadSessionInfo(session: SessionState): Promise<SessionFileInfo | null> {
    const sessionFile = await this.resolveSessionFile(session);
    if (!sessionFile) {
      return null;
    }
    try {
      return await readSessionInfo(sessionFile);
    } catch (error) {
      logWarn(`session info read failed for ${session.id}: ${(error as Error).message}`);
      return null;
    }
  }

  private async resolveSessionFile(session: SessionState): Promise<string | null> {
    if (session.sessionFile) {
      return session.sessionFile;
    }
    let response: PiResponse;
    try {
      response = await session.pi.request({ type: "get_state" }, PI_REQUEST_TIMEOUT_MS);
    } catch (error) {
      logWarn(`session file lookup failed for ${session.id}: ${(error as Error).message}`);
      return null;
    }
    if (!response.success || !response.data || typeof response.data !== "object") {
      return null;
    }
    const sessionFile = (response.data as { sessionFile?: unknown }).sessionFile;
    if (typeof sessionFile !== "string") {
      return null;
    }
    session.sessionFile = sessionFile;
    return sessionFile;
  }

  private formatStats(data: SessionStats, contextWindow?: number, maxTokens?: number): string {
    const tokens = data.tokens ?? {};
    const lines = ["Session stats:"];
    if (tokens.total !== undefined) {
      const contextMax = contextWindow ? ` / ${contextWindow.toLocaleString()}` : "";
      lines.push(`- Context tokens: ${tokens.total.toLocaleString()}${contextMax}`);
    }
    if (maxTokens) {
      lines.push(`- Max output: ${maxTokens.toLocaleString()}`);
    }
    const tokenParts = [
      formatCount("input", tokens.input),
      formatCount("output", tokens.output),
      formatCount("cache read", tokens.cacheRead),
      formatCount("cache write", tokens.cacheWrite),
      formatCount("total", tokens.total),
    ].filter(Boolean) as string[];
    if (tokenParts.length > 0) {
      lines.push(`- Tokens: ${tokenParts.join(", ")}`);
    }
    if (typeof data.cost === "number") {
      lines.push(`- Cost: $${data.cost.toFixed(4)}`);
    }
    return lines.join("\n");
  }

  /**
   * Get a short summary string for appending to agent response.
   */
  async getSummary(session: SessionState): Promise<string | null> {
    let statsResponse: PiResponse;
    try {
      statsResponse = await session.pi.request({ type: "get_session_stats" }, PI_REQUEST_TIMEOUT_MS);
    } catch {
      return null;
    }
    if (!statsResponse.success) {
      return null;
    }
    const data = statsResponse.data && typeof statsResponse.data === "object" ? (statsResponse.data as SessionStats) : {};
    const model = session.currentModelId ? session.modelMap.get(session.currentModelId) : undefined;
    return this.formatSummary(data, model?.contextWindow);
  }

  private formatSummary(data: SessionStats, contextWindow?: number): string {
    const tokens = data.tokens ?? {};
    const parts: string[] = [];
    if (tokens.total !== undefined && contextWindow) {
      const pct = ((tokens.total / contextWindow) * 100).toFixed(0);
      parts.push(`Context: ${tokens.total.toLocaleString()}/${contextWindow.toLocaleString()} (${pct}%)`);
    } else if (tokens.total !== undefined) {
      parts.push(`Tokens: ${tokens.total.toLocaleString()}`);
    }
    if (typeof data.cost === "number") {
      parts.push(`Cost: $${data.cost.toFixed(4)}`);
    }
    return parts.length > 0 ? parts.join(" | ") : "";
  }
}

function formatCount(label: string, value?: number): string | null {
  if (typeof value !== "number") {
    return null;
  }
  return `${label} ${value.toLocaleString()}`;
}
