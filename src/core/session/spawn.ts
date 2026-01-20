import { logError } from "../../logger";
import { PiProcess } from "../../pi/process";
import type { PiLine } from "../../pi/types";
import { createSessionState } from "../config/config";
import type { SessionState } from "./types";

export type SessionSpawnOptions = {
  sessionId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onLine: (state: SessionState, line: PiLine) => void;
  onError: (state: SessionState, error: Error) => void;
  mcpServers?: unknown[];
};

export function spawnSessionState(options: SessionSpawnOptions): SessionState {
  const pi = new PiProcess({ cwd: options.cwd, env: options.env });
  const state = createSessionState(options.sessionId, options.cwd, pi, options.mcpServers);

  pi.onLine((line) => options.onLine(state, line));
  pi.onError((error) => {
    logError(`pi process error for session ${options.sessionId}: ${error.message}`);
    options.onError(state, error);
  });

  return state;
}
