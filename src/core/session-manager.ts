import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logError, logWarn } from "../logger";
import { PiProcess } from "../pi/process";
import type {
  ContentBlock,
  SessionConfigOption,
  SessionModelState,
  SessionUpdate,
  SetSessionConfigOptionRequest,
  StopReason,
} from "@agentclientprotocol/sdk";
import { createSessionState, refreshSessionConfig, resolveModelId } from "./session-config";
import { DEFAULT_COMMANDS } from "./session-consts";
import { SessionRuntime } from "./session-runtime";
import type { SessionState } from "./types";

export class SessionManager {
  private readonly sessions = new Map<string, SessionState>();
  private emitUpdate: (params: { sessionId: string; update: SessionUpdate }) => void;
  private readonly sessionMapPath: string;
  private readonly runtime: SessionRuntime;

  constructor() {
    this.emitUpdate = () => undefined;
    this.sessionMapPath = path.join(os.homedir(), ".pi", "pi-acp", "session-map.json");
    this.runtime = new SessionRuntime({
      emitUpdate: (sessionId, update) => this.emitUpdate({ sessionId, update }),
    });
  }

  setEmitter(emitUpdate: (params: { sessionId: string; update: SessionUpdate }) => void): void {
    this.emitUpdate = emitUpdate;
  }

  async createSession(
    cwd: string,
    _mcpServers: unknown[]
  ): Promise<{
    sessionId: string;
    models: SessionModelState | null;
    configOptions: SessionConfigOption[] | null;
  }> {
    const sessionId = randomUUID();
    const pi = new PiProcess({ cwd });
    const state = createSessionState(sessionId, cwd, pi);

    pi.onLine((line) => this.runtime.handlePiLine(state, line));
    pi.onError((error: Error) => {
      logError(`pi process error for session ${sessionId}: ${error.message}`);
      if (state.pendingPrompt) {
        state.pendingPrompt.reject(error);
        state.pendingPrompt = undefined;
      }
    });

    this.sessions.set(sessionId, state);
    void this.captureSessionFile(state);

    const { models, configOptions } = await refreshSessionConfig(state);
    this.queueSessionInitUpdates(sessionId, configOptions);
    return { sessionId, models, configOptions };
  }

  async loadSession(
    sessionId: string,
    cwd: string
  ): Promise<{
    models: SessionModelState | null;
    configOptions: SessionConfigOption[] | null;
  }> {
    const map = await this.readSessionMap();
    const entry = map[sessionId];
    if (!entry) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    const state = await this.createSessionFromPath(sessionId, cwd, entry.piSessionPath);

    await this.runtime.replayHistory(state);
    const { models, configOptions } = await refreshSessionConfig(state);
    this.queueSessionInitUpdates(sessionId, configOptions);
    return { models, configOptions };
  }

  async resumeSession(
    sessionId: string,
    cwd: string
  ): Promise<{
    models: SessionModelState | null;
    configOptions: SessionConfigOption[] | null;
  }> {
    const map = await this.readSessionMap();
    const entry = map[sessionId];
    if (!entry) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    const state = await this.createSessionFromPath(sessionId, cwd, entry.piSessionPath);
    const { models, configOptions } = await refreshSessionConfig(state);
    this.queueSessionInitUpdates(sessionId, configOptions);
    return { models, configOptions };
  }

  listSessions(): Array<{ sessionId: string; cwd: string }> {
    return Array.from(this.sessions.values()).map((session) => ({
      sessionId: session.id,
      cwd: session.cwd,
    }));
  }

  async prompt(sessionId: string, prompt: ContentBlock[]): Promise<StopReason> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    if (session.pendingPrompt) {
      throw new Error("Prompt already in progress");
    }

    if (await this.runtime.handleSlashCommand(session, prompt)) {
      return "end_turn";
    }

    const { message, images } = this.runtime.buildPrompt(prompt);
    session.pi.send({
      type: "prompt",
      message,
      images: images.length > 0 ? images : undefined,
    });

    return await new Promise((resolve, reject) => {
      session.pendingPrompt = { resolve, reject };
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
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    const resolved = resolveModelId(session, modelId);
    if (!resolved) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    const response = await session.pi.request({
      type: "set_model",
      provider: resolved.provider,
      modelId: resolved.id,
    });

    if (!response.success) {
      throw new Error(response.error ?? "Failed to set model");
    }

    const { configOptions } = await refreshSessionConfig(session);
    this.emitUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: configOptions ?? [],
      },
    });
  }

  async setConfigOption(params: SetSessionConfigOptionRequest): Promise<{ configOptions: SessionConfigOption[] }> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }

    switch (params.configId) {
      case "thinking_level":
      case "reasoning_effort": {
        const response = await session.pi.request({
          type: "set_thinking_level",
          level: params.value as "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
        });

        if (!response.success) {
          throw new Error(response.error ?? "Failed to set thinking level");
        }

        const { configOptions } = await refreshSessionConfig(session);
        this.emitUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "config_option_update",
            configOptions: configOptions ?? [],
          },
        });

        return { configOptions: configOptions ?? [] };
      }
      case "steering_mode": {
        const response = await session.pi.request({
          type: "set_steering_mode",
          mode: params.value as "all" | "one-at-a-time",
        });
        if (!response.success) {
          throw new Error(response.error ?? "Failed to set steering mode");
        }
        const { configOptions } = await refreshSessionConfig(session);
        this.emitUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "config_option_update",
            configOptions: configOptions ?? [],
          },
        });
        return { configOptions: configOptions ?? [] };
      }
      case "follow_up_mode": {
        const response = await session.pi.request({
          type: "set_follow_up_mode",
          mode: params.value as "all" | "one-at-a-time",
        });
        if (!response.success) {
          throw new Error(response.error ?? "Failed to set follow-up mode");
        }
        const { configOptions } = await refreshSessionConfig(session);
        this.emitUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "config_option_update",
            configOptions: configOptions ?? [],
          },
        });
        return { configOptions: configOptions ?? [] };
      }
      case "auto_compaction": {
        const response = await session.pi.request({
          type: "set_auto_compaction",
          enabled: params.value === "on",
        });
        if (!response.success) {
          throw new Error(response.error ?? "Failed to set auto compaction");
        }
        const { configOptions } = await refreshSessionConfig(session);
        this.emitUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "config_option_update",
            configOptions: configOptions ?? [],
          },
        });
        return { configOptions: configOptions ?? [] };
      }
      case "auto_retry": {
        const response = await session.pi.request({
          type: "set_auto_retry",
          enabled: params.value === "on",
        });
        if (!response.success) {
          throw new Error(response.error ?? "Failed to set auto retry");
        }
        const { configOptions } = await refreshSessionConfig(session);
        this.emitUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "config_option_update",
            configOptions: configOptions ?? [],
          },
        });
        return { configOptions: configOptions ?? [] };
      }
      case "model": {
        await this.setModel(params.sessionId, params.value);
        return { configOptions: session.configOptions ?? [] };
      }
      default:
        throw new Error(`Unknown config option: ${params.configId}`);
    }
  }

  private async createSessionFromPath(sessionId: string, cwd: string, sessionPath: string): Promise<SessionState> {
    const pi = new PiProcess({ cwd });
    const state = createSessionState(sessionId, cwd, pi);

    pi.onLine((line) => this.runtime.handlePiLine(state, line));
    pi.onError((error: Error) => {
      logError(`pi process error for session ${sessionId}: ${error.message}`);
      if (state.pendingPrompt) {
        state.pendingPrompt.reject(error);
        state.pendingPrompt = undefined;
      }
    });

    this.sessions.set(sessionId, state);

    const response = await pi.request({
      type: "switch_session",
      sessionPath,
    });
    if (!response.success) {
      throw new Error(response.error ?? "Failed to switch session");
    }

    return state;
  }

  private queueSessionInitUpdates(sessionId: string, configOptions: SessionConfigOption[] | null): void {
    setTimeout(() => {
      if (!this.sessions.has(sessionId)) {
        return;
      }
      this.emitUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: DEFAULT_COMMANDS,
        },
      });
      this.emitUpdate({
        sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: configOptions ?? [],
        },
      });
    }, 0);
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
      await this.writeSessionMap(session.id, sessionFile);
    } catch (error) {
      logWarn(`session map update failed: ${(error as Error).message}`);
    }
  }

  private async writeSessionMap(sessionId: string, piSessionPath: string): Promise<void> {
    const map = await this.readSessionMap();
    map[sessionId] = { piSessionPath };
    await mkdir(path.dirname(this.sessionMapPath), { recursive: true });
    await writeFile(this.sessionMapPath, JSON.stringify(map, null, 2));
  }

  private async readSessionMap(): Promise<Record<string, { piSessionPath: string }>> {
    try {
      const raw = await readFile(this.sessionMapPath, "utf8");
      const data = JSON.parse(raw) as Record<string, { piSessionPath: string }>;
      return data ?? {};
    } catch {
      return {};
    }
  }
}
