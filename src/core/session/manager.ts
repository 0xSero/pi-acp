import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { logWarn } from "../../logger";
import type {
  ContentBlock,
  ListSessionsRequest,
  SessionConfigOption,
  SessionInfo,
  SessionModelState,
  SessionUpdate,
  SetSessionConfigOptionRequest,
  StopReason,
} from "@agentclientprotocol/sdk";
import { refreshSessionConfig, resolveModelId } from "../config/config";
import { DEFAULT_COMMANDS } from "../config/consts";
import { SessionRuntime } from "../runtime/runtime";
import type { SessionState } from "./types";
import { SessionMapStore } from "./map";
import { createForkedSessionFile, readSessionInfo, scanSessions } from "./metadata";
import { spawnSessionState } from "./spawn";

export class SessionManager {
  private readonly sessions = new Map<string, SessionState>();
  private emitUpdate: (params: { sessionId: string; update: SessionUpdate }) => void = () => undefined;
  private readonly sessionMap = new SessionMapStore(
    path.join(os.homedir(), ".pi", "pi-acp", "session-map.json")
  );
  private readonly runtime = new SessionRuntime({
    emitUpdate: (sessionId, update) => this.emitUpdate({ sessionId, update }),
  });

  setEmitter(emitUpdate: (params: { sessionId: string; update: SessionUpdate }) => void): void {
    this.emitUpdate = emitUpdate;
  }

  async createSession(cwd: string, mcpServers: unknown[]): Promise<{
    sessionId: string;
    models: SessionModelState | null;
    configOptions: SessionConfigOption[] | null;
  }> {
    const sessionId = randomUUID();
    const state = this.spawnSession(sessionId, cwd, mcpServers);
    this.sessions.set(sessionId, state);
    await this.captureSessionFile(state);
    const { models, configOptions } = await refreshSessionConfig(state);
    this.queueSessionInitUpdates(state, configOptions);
    return { sessionId, models, configOptions };
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: unknown[]): Promise<{
    models: SessionModelState | null;
    configOptions: SessionConfigOption[] | null;
  }> {
    const sessionPath = await this.resolveSessionPath(sessionId, cwd);
    if (!sessionPath) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const state = await this.createSessionFromPath(sessionId, cwd, sessionPath, mcpServers);
    const { models, configOptions } = await refreshSessionConfig(state);
    this.queueSessionInitUpdates(state, configOptions);
    void this.runtime.replayHistory(state);
    return { models, configOptions };
  }

  async resumeSession(sessionId: string, cwd: string, mcpServers: unknown[]): Promise<{
    models: SessionModelState | null;
    configOptions: SessionConfigOption[] | null;
  }> {
    const sessionPath = await this.resolveSessionPath(sessionId, cwd);
    if (!sessionPath) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const state = await this.createSessionFromPath(sessionId, cwd, sessionPath, mcpServers);
    const { models, configOptions } = await refreshSessionConfig(state);
    this.queueSessionInitUpdates(state, configOptions);
    return { models, configOptions };
  }

  async forkSession(sourceSessionId: string, cwd: string, mcpServers: unknown[]): Promise<{
    sessionId: string;
    models: SessionModelState | null;
    configOptions: SessionConfigOption[] | null;
  }> {
    const sourcePath = await this.resolveSessionPath(sourceSessionId, null);
    if (!sourcePath) {
      throw new Error(`Unknown session: ${sourceSessionId}`);
    }
    const forked = await createForkedSessionFile(sourcePath, cwd);
    await this.sessionMap.set(forked.sessionId, forked.filePath);
    const state = await this.createSessionFromPath(forked.sessionId, cwd, forked.filePath, mcpServers);
    const { models, configOptions } = await refreshSessionConfig(state);
    this.queueSessionInitUpdates(state, configOptions);
    void this.runtime.replayHistory(state);
    return { sessionId: forked.sessionId, models, configOptions };
  }

  async listSessions(_params?: ListSessionsRequest): Promise<SessionInfo[]> {
    const { sessions, map } = await scanSessions({ cwd: null });
    const mapEntries = Object.fromEntries(map.entries());
    if (Object.keys(mapEntries).length > 0) {
      await this.sessionMap.merge(mapEntries);
    }
    return sessions.map((session) => ({
      sessionId: session.sessionId,
      cwd: session.cwd,
      title: session.title ?? null,
      updatedAt: session.updatedAt ?? null,
      _meta: {
        messageCount: session.messageCount,
      },
    }));
  }

  async prompt(sessionId: string, prompt: ContentBlock[]): Promise<StopReason> {
    const session = this.getSession(sessionId);
    if (session.pendingPrompt) {
      throw new Error("Prompt already in progress");
    }
    if (await this.runtime.handleSlashCommand(session, prompt)) {
      return "end_turn";
    }
    const { message, images } = this.runtime.buildPrompt(prompt);
    const inferredTitle = session.title ?? inferTitleFromPrompt(prompt);
    if (inferredTitle && session.title !== inferredTitle) {
      session.title = inferredTitle;
      this.emitUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "session_info_update",
          title: inferredTitle,
          updatedAt: new Date().toISOString(),
        },
      });
    }
    session.pi.send({ type: "prompt", message, images: images.length > 0 ? images : undefined });
    return await new Promise((resolve, reject) => {
      const heartbeatMs = 30000;
      const sendHeartbeat = () => {
        this.emitUpdate({
          sessionId: session.id,
          update: { sessionUpdate: "session_info_update", updatedAt: new Date().toISOString() },
        });
      };
      sendHeartbeat();
      const heartbeatId = setInterval(sendHeartbeat, heartbeatMs);
      session.pendingPrompt = {
        resolve: (reason) => {
          clearInterval(heartbeatId);
          resolve(reason);
        },
        reject: (error) => {
          clearInterval(heartbeatId);
          reject(error);
        },
      };
    });
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.pi.send({ type: "abort" });
    if (session.pendingPrompt) {
      session.pendingPrompt.resolve("cancelled");
      session.pendingPrompt = undefined;
    }
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    const session = this.getSession(sessionId);
    const resolved = resolveModelId(session, modelId);
    if (!resolved) {
      throw new Error(`Unknown model: ${modelId}`);
    }
    const response = await session.pi.request({ type: "set_model", provider: resolved.provider, modelId: resolved.id });
    if (!response.success) {
      throw new Error(response.error ?? "Failed to set model");
    }
    await this.refreshConfigOptions(session);
  }

  async setConfigOption(params: SetSessionConfigOptionRequest): Promise<{ configOptions: SessionConfigOption[] }> {
    const session = this.getSession(params.sessionId);
    switch (params.configId) {
      case "thinking_level":
      case "reasoning_effort":
        await this.setThinkingLevel(session, params.value as "off" | "minimal" | "low" | "medium" | "high" | "xhigh");
        break;
      case "steering_mode":
        await this.setModeOption(session, "set_steering_mode", "steering mode", params.value as "all" | "one-at-a-time");
        break;
      case "follow_up_mode":
        await this.setModeOption(session, "set_follow_up_mode", "follow-up mode", params.value as "all" | "one-at-a-time");
        break;
      case "auto_compaction":
        await this.setToggleOption(session, "set_auto_compaction", "auto compaction", params.value === "on");
        break;
      case "auto_retry":
        await this.setToggleOption(session, "set_auto_retry", "auto retry", params.value === "on");
        break;
      case "model":
        await this.setModel(params.sessionId, params.value);
        break;
      default:
        throw new Error(`Unknown config option: ${params.configId}`);
    }
    return { configOptions: session.configOptions ?? [] };
  }

  private getSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session;
  }

  private async resolveSessionPath(sessionId: string, _cwd?: string | null): Promise<string | null> {
    const active = this.sessions.get(sessionId);
    if (active?.sessionFile) {
      return active.sessionFile;
    }

    const mapped = await this.sessionMap.get(sessionId);
    if (mapped) {
      return mapped;
    }

    const { map } = await scanSessions({ cwd: null });
    const resolved = map.get(sessionId) ?? null;
    const mapEntries = Object.fromEntries(map.entries());
    if (Object.keys(mapEntries).length > 0) {
      await this.sessionMap.merge(mapEntries);
    }
    return resolved;
  }

  private spawnSession(sessionId: string, cwd: string, mcpServers: unknown[]): SessionState {
    const env = buildMcpEnv(mcpServers);
    return spawnSessionState({
      sessionId,
      cwd,
      env,
      mcpServers,
      onLine: (session, line) => this.runtime.handlePiLine(session, line),
      onError: (session, error) => {
        if (session.pendingPrompt) {
          session.pendingPrompt.reject(error);
          session.pendingPrompt = undefined;
        }
      },
    });
  }

  private async createSessionFromPath(
    sessionId: string,
    cwd: string,
    sessionPath: string,
    mcpServers: unknown[]
  ): Promise<SessionState> {
    const state = this.spawnSession(sessionId, cwd, mcpServers);
    state.sessionFile = sessionPath;
    this.sessions.set(sessionId, state);
    await this.sessionMap.set(sessionId, sessionPath);
    const response = await state.pi.request({ type: "switch_session", sessionPath });
    if (!response.success) {
      throw new Error(response.error ?? "Failed to switch session");
    }
    return state;
  }

  private async refreshConfigOptions(session: SessionState): Promise<void> {
    const { configOptions } = await refreshSessionConfig(session);
    this.emitUpdate({ sessionId: session.id, update: { sessionUpdate: "config_option_update", configOptions: configOptions ?? [] } });
  }

  private queueSessionInitUpdates(session: SessionState, _configOptions: SessionConfigOption[] | null): void {
    setTimeout(() => {
      if (!this.sessions.has(session.id)) {
        return;
      }
      this.emitUpdate({ sessionId: session.id, update: { sessionUpdate: "available_commands_update", availableCommands: DEFAULT_COMMANDS } });
      this.emitUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "session_info_update",
          title: session.title ?? null,
          updatedAt: new Date().toISOString(),
        },
      });
      if (session.mcpServers && session.mcpServers.length > 0) {
        this.emitUpdate({ sessionId: session.id, update: { sessionUpdate: "session_info_update", _meta: { mcpServers: session.mcpServers } } });
      }
      void this.emitInitialSessionInfo(session);
    }, 0);
  }

  private async emitInitialSessionInfo(session: SessionState): Promise<void> {
    const sessionFile = session.sessionFile;
    if (!sessionFile) {
      return;
    }
    const info = await readSessionInfo(sessionFile);
    if (!info) {
      return;
    }
    this.emitUpdate({
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

  private async captureSessionFile(session: SessionState): Promise<void> {
    try {
      const response = await session.pi.request({ type: "get_state" });
      if (!response.success || !response.data || typeof response.data !== "object") {
        return;
      }
      const sessionFile = (response.data as { sessionFile?: unknown }).sessionFile;
      if (typeof sessionFile !== "string") {
        return;
      }
      session.sessionFile = sessionFile;
      await this.sessionMap.set(session.id, sessionFile);
    } catch (error) {
      logWarn(`session map update failed: ${(error as Error).message}`);
    }
  }

  private async setThinkingLevel(session: SessionState, level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): Promise<void> {
    const response = await session.pi.request({ type: "set_thinking_level", level });
    if (!response.success) {
      throw new Error(response.error ?? "Failed to set thinking level");
    }
    await this.refreshConfigOptions(session);
  }

  private async setModeOption(
    session: SessionState,
    type: "set_steering_mode" | "set_follow_up_mode",
    label: string,
    value: "all" | "one-at-a-time"
  ): Promise<void> {
    const response = await session.pi.request({ type, mode: value });
    if (!response.success) {
      throw new Error(response.error ?? `Failed to set ${label}`);
    }
    await this.refreshConfigOptions(session);
  }

  private async setToggleOption(
    session: SessionState,
    type: "set_auto_compaction" | "set_auto_retry",
    label: string,
    enabled: boolean
  ): Promise<void> {
    const response = await session.pi.request({ type, enabled });
    if (!response.success) {
      throw new Error(response.error ?? `Failed to set ${label}`);
    }
    await this.refreshConfigOptions(session);
  }
}

function buildMcpEnv(mcpServers: unknown[]): NodeJS.ProcessEnv | undefined {
  return mcpServers && mcpServers.length > 0 ? { PI_ACP_MCP_SERVERS: JSON.stringify(mcpServers) } : undefined;
}

function inferTitleFromPrompt(prompt: ContentBlock[]): string | null {
  for (const block of prompt) {
    if (block.type === "text") {
      const trimmed = block.text.trim();
      if (trimmed) {
        return trimmed.length > 160 ? `${trimmed.slice(0, 159).trim()}…` : trimmed;
      }
    }
    if (block.type === "resource") {
      const resource = block.resource;
      if ("text" in resource) {
        const text = resource.text?.trim();
        if (text) {
          return text.length > 160 ? `${text.slice(0, 159).trim()}…` : text;
        }
      }
    }
  }
  return null;
}
