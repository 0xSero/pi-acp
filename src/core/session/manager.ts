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
import { SessionRuntime } from "../runtime/runtime";
import type { SessionState } from "./types";
import { SessionMapStore } from "./map";
import { createForkedSessionFile, readSessionInfo, scanSessions } from "./metadata";
import { spawnSessionState } from "./spawn";
import { buildMcpEnv, emitInitialSessionInfo, inferTitleFromPrompt, queueSessionInitUpdates, withHeartbeat } from "./updates";
import { captureSessionFile, resolveSessionPath } from "./resolve";
import { getConfigOptions, refreshConfigOptions, setModeOption, setThinkingLevel, setToggleOption } from "./config-actions";

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
    await captureSessionFile(state, this.sessionMap, logWarn);
    const { models, configOptions } = await refreshSessionConfig(state);
    this.queueSessionInitUpdates(state, configOptions);
    return { sessionId, models, configOptions };
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: unknown[]): Promise<{
    models: SessionModelState | null;
    configOptions: SessionConfigOption[] | null;
  }> {
    const sessionPath = await resolveSessionPath(this.sessions, this.sessionMap, sessionId);
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
    const sessionPath = await resolveSessionPath(this.sessions, this.sessionMap, sessionId);
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
    const sourcePath = await resolveSessionPath(this.sessions, this.sessionMap, sourceSessionId);
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
      _meta: { messageCount: session.messageCount },
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
    this.runtime.beginPrompt(session);
    session.pi.send({ type: "prompt", message, images: images.length > 0 ? images : undefined });
    return await new Promise((resolve, reject) => {
      const wrapped = withHeartbeat(session, this.emitUpdate, resolve, reject);
      session.pendingPrompt = { resolve: wrapped.resolve, reject: wrapped.reject };
    });
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.pi.send({ type: "abort" });
    this.runtime.cancelPrompt(session);
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
    await refreshConfigOptions(session, this.emitUpdate);
  }

  async setConfigOption(params: SetSessionConfigOptionRequest): Promise<{ configOptions: SessionConfigOption[] }> {
    const session = this.getSession(params.sessionId);
    switch (params.configId) {
      case "thinking_level":
      case "reasoning_effort":
        await setThinkingLevel(session, this.emitUpdate, params.value as "off" | "minimal" | "low" | "medium" | "high" | "xhigh");
        break;
      case "steering_mode":
        await setModeOption(session, this.emitUpdate, "set_steering_mode", "steering mode", params.value as "all" | "one-at-a-time");
        break;
      case "follow_up_mode":
        await setModeOption(session, this.emitUpdate, "set_follow_up_mode", "follow-up mode", params.value as "all" | "one-at-a-time");
        break;
      case "auto_compaction":
        await setToggleOption(session, this.emitUpdate, "set_auto_compaction", "auto compaction", params.value === "on");
        break;
      case "auto_retry":
        await setToggleOption(session, this.emitUpdate, "set_auto_retry", "auto retry", params.value === "on");
        break;
      case "model":
        await this.setModel(params.sessionId, params.value);
        break;
      default:
        throw new Error(`Unknown config option: ${params.configId}`);
    }
    return { configOptions: getConfigOptions(session) };
  }

  private getSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session;
  }

  private spawnSession(sessionId: string, cwd: string, mcpServers: unknown[]): SessionState {
    const env = buildMcpEnv(mcpServers);
    const state = spawnSessionState({
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
    this.runtime.initSessionStatus(state);
    return state;
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

  private queueSessionInitUpdates(session: SessionState, configOptions: SessionConfigOption[] | null): void {
    queueSessionInitUpdates({
      sessions: this.sessions,
      session,
      emitUpdate: this.emitUpdate,
      configOptions,
      onInitialInfo: (target) => emitInitialSessionInfo(target, this.emitUpdate),
    });
  }
}

export async function ensureSessionInfo(session: SessionState): Promise<void> {
  if (!session.sessionFile) {
    return;
  }
  const info = await readSessionInfo(session.sessionFile);
  if (info?.title) {
    session.title = info.title;
  }
}
