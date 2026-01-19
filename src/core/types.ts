import type { SessionConfigOption, SessionModelState, StopReason } from "@agentclientprotocol/sdk";
import type { PiProcess } from "../pi/process";

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
}

export interface SessionState {
  id: string;
  cwd: string;
  pi: PiProcess;
  pendingPrompt?: PendingPrompt;
  toolCallSnapshots: Map<string, { path: string; oldText: string }>;
  modelMap: Map<string, PiModel>;
  currentModelId?: string;
  thinkingLevel?: string;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  autoCompactionEnabled?: boolean;
  autoRetryEnabled?: boolean;
  configOptions?: SessionConfigOption[];
}

export type SessionConfigResult = {
  models: SessionModelState | null;
  configOptions: SessionConfigOption[] | null;
};
