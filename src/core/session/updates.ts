import type { ContentBlock, SessionConfigOption, SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import { DEFAULT_COMMANDS } from "../config/consts";
import { readSessionInfo } from "./metadata";
import type { SessionState } from "./types";
import { normalizeTitle } from "./utils";

export function queueSessionInitUpdates(options: {
  sessions: Map<string, SessionState>;
  session: SessionState;
  emitUpdate: (params: { sessionId: string; update: SessionUpdate }) => void;
  configOptions: SessionConfigOption[] | null;
  onInitialInfo: (session: SessionState) => Promise<void>;
}): void {
  const { sessions, session, emitUpdate, configOptions, onInitialInfo } = options;
  setTimeout(() => {
    if (!sessions.has(session.id)) {
      return;
    }
    emitUpdate({ sessionId: session.id, update: { sessionUpdate: "available_commands_update", availableCommands: DEFAULT_COMMANDS } });
    emitUpdate({ sessionId: session.id, update: { sessionUpdate: "config_option_update", configOptions: configOptions ?? [] } });
    emitUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "session_info_update",
        title: session.title ?? null,
        updatedAt: new Date().toISOString(),
      },
    });
    if (session.mcpServers && session.mcpServers.length > 0) {
      emitUpdate({ sessionId: session.id, update: { sessionUpdate: "session_info_update", _meta: { mcpServers: session.mcpServers } } });
    }
    void onInitialInfo(session);
  }, 0);
}

export async function emitInitialSessionInfo(
  session: SessionState,
  emitUpdate: (params: { sessionId: string; update: SessionUpdate }) => void
): Promise<void> {
  const sessionFile = session.sessionFile;
  if (!sessionFile) {
    return;
  }
  const info = await readSessionInfo(sessionFile);
  if (!info) {
    return;
  }
  emitUpdate({
    sessionId: session.id,
    update: {
      sessionUpdate: "session_info_update",
      title: info.title ?? null,
      updatedAt: info.updatedAt ?? null,
      _meta: {
        messageCount: info.messageCount,
        sessionFile: info.filePath,
      },
    },
  });
}

export function inferTitleFromPrompt(prompt: ContentBlock[]): string | null {
  for (const block of prompt) {
    if (block.type === "text") {
      const trimmed = block.text.trim();
      if (trimmed) {
        return normalizeTitle(trimmed) ?? null;
      }
    }
    if (block.type === "resource") {
      const resource = block.resource;
      if ("text" in resource) {
        const text = resource.text?.trim();
        if (text) {
          return normalizeTitle(text) ?? null;
        }
      }
    }
  }
  return null;
}

export function withHeartbeat(
  session: SessionState,
  emitUpdate: (params: { sessionId: string; update: SessionUpdate }) => void,
  resolve: (reason: StopReason) => void,
  reject: (error: Error) => void
): { resolve: (reason: StopReason) => void; reject: (error: Error) => void } {
  const heartbeatMs = 30000;
  const sendHeartbeat = () => {
    emitUpdate({
      sessionId: session.id,
      update: { sessionUpdate: "session_info_update", updatedAt: new Date().toISOString() },
    });
  };
  sendHeartbeat();
  const heartbeatId = setInterval(sendHeartbeat, heartbeatMs);
  return {
    resolve: (reason) => {
      clearInterval(heartbeatId);
      resolve(reason);
    },
    reject: (error) => {
      clearInterval(heartbeatId);
      reject(error);
    },
  };
}

export function buildMcpEnv(mcpServers: unknown[]): NodeJS.ProcessEnv | undefined {
  return mcpServers && mcpServers.length > 0 ? { PI_ACP_MCP_SERVERS: JSON.stringify(mcpServers) } : undefined;
}
