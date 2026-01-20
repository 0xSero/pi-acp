import type { SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk";
import { refreshSessionConfig } from "../config/config";
import type { SessionState } from "./types";

type EmitUpdate = (params: { sessionId: string; update: SessionUpdate }) => void;

export async function refreshConfigOptions(session: SessionState, emitUpdate: EmitUpdate): Promise<void> {
  const { configOptions } = await refreshSessionConfig(session);
  emitUpdate({ sessionId: session.id, update: { sessionUpdate: "config_option_update", configOptions: configOptions ?? [] } });
}

export async function setThinkingLevel(
  session: SessionState,
  emitUpdate: EmitUpdate,
  level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
): Promise<void> {
  const response = await session.pi.request({ type: "set_thinking_level", level });
  if (!response.success) {
    throw new Error(response.error ?? "Failed to set thinking level");
  }
  await refreshConfigOptions(session, emitUpdate);
}

export async function setModeOption(
  session: SessionState,
  emitUpdate: EmitUpdate,
  type: "set_steering_mode" | "set_follow_up_mode",
  label: string,
  value: "all" | "one-at-a-time"
): Promise<void> {
  const response = await session.pi.request({ type, mode: value });
  if (!response.success) {
    throw new Error(response.error ?? `Failed to set ${label}`);
  }
  await refreshConfigOptions(session, emitUpdate);
}

export async function setToggleOption(
  session: SessionState,
  emitUpdate: EmitUpdate,
  type: "set_auto_compaction" | "set_auto_retry",
  label: string,
  enabled: boolean
): Promise<void> {
  const response = await session.pi.request({ type, enabled });
  if (!response.success) {
    throw new Error(response.error ?? `Failed to set ${label}`);
  }
  await refreshConfigOptions(session, emitUpdate);
}

export function getConfigOptions(session: SessionState): SessionConfigOption[] {
  return session.configOptions ?? [];
}
