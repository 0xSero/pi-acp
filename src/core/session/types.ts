import type { SessionConfigOption, SessionModelState, StopReason } from "@agentclientprotocol/sdk";
import type { PiProcess } from "../../pi/process";

export interface PendingPrompt {
  resolve: (reason: StopReason) => void;
  reject: (error: Error) => void;
}

export interface PiModel {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface SessionState {
  id: string;
  cwd: string;
  pi: PiProcess;
  pendingPrompt?: PendingPrompt;
  sessionFile?: string;
  toolCallSnapshots: Map<string, { path: string; oldText: string }>;
  toolCallInputs: Map<string, { summary?: string; locations?: string[]; command?: string }>;
  modelMap: Map<string, PiModel>;
  currentModelId?: string;
  thinkingLevel?: string;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  autoCompactionEnabled?: boolean;
  autoRetryEnabled?: boolean;
  configOptions?: SessionConfigOption[];
  mcpServers?: unknown[];
  title?: string;
  statusToolCallId?: string;
  statusState?: "idle" | "running" | "cancelled" | "error";
  statusDetail?: string | null;
}

export type SessionConfigResult = {
  models: SessionModelState | null;
  configOptions: SessionConfigOption[] | null;
};
