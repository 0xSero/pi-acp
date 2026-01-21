import type { SessionState } from "../session/types";

type SessionStatusState = "idle" | "running" | "cancelled" | "error";

type StatusUpdate = {
  state: SessionStatusState;
  detail?: string;
};

/**
 * Session status reporter - currently disabled.
 *
 * The synthetic "session status" tool_call was causing "Tool call not found" errors
 * in Zed because the client doesn't expect fake tool calls that aren't from the LLM.
 *
 * The official claude-code-acp implementation doesn't emit synthetic tool calls,
 * so we're disabling this to match their behavior.
 */
export class SessionStatusReporter {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  update(_session: SessionState, _update: StatusUpdate): void {
    // No-op: Synthetic status tool calls disabled to avoid Zed compatibility issues
  }
}
