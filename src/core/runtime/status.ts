import type { SessionUpdate, ToolCallContent, ToolCallStatus } from "@agentclientprotocol/sdk";
import type { SessionState } from "../session/types";

type EmitUpdate = (sessionId: string, update: SessionUpdate) => void;

type SessionStatusState = "idle" | "running" | "cancelled" | "error";

type StatusUpdate = {
  state: SessionStatusState;
  detail?: string;
};

export class SessionStatusReporter {
  private readonly emitUpdate: EmitUpdate;

  constructor(emitUpdate: EmitUpdate) {
    this.emitUpdate = emitUpdate;
  }

  ensure(session: SessionState): void {
    if (session.statusToolCallId) {
      return;
    }
    session.statusToolCallId = `session_status:${session.id}`;
    this.emitUpdate(session.id, {
      sessionUpdate: "tool_call",
      toolCallId: session.statusToolCallId,
      title: "Session status",
      kind: "other",
      status: "completed",
      content: this.buildContent({ state: "idle" }),
    });
    session.statusState = "idle";
    session.statusDetail = null;
  }

  update(session: SessionState, update: StatusUpdate): void {
    this.ensure(session);
    if (!session.statusToolCallId) {
      return;
    }
    if (session.statusState === update.state && session.statusDetail === (update.detail ?? null)) {
      return;
    }
    session.statusState = update.state;
    session.statusDetail = update.detail ?? null;

    this.emitUpdate(session.id, {
      sessionUpdate: "tool_call_update",
      toolCallId: session.statusToolCallId,
      status: this.mapStatus(update.state),
      content: this.buildContent(update),
    });
  }

  private mapStatus(state: SessionStatusState): ToolCallStatus {
    switch (state) {
      case "running":
        return "in_progress";
      case "cancelled":
      case "error":
        return "failed";
      case "idle":
      default:
        return "completed";
    }
  }

  private buildContent(update: StatusUpdate): ToolCallContent[] {
    const lines = [`Status: ${this.formatState(update.state)}`];
    if (update.detail) {
      lines.push(`Detail: ${update.detail}`);
    }
    return [{ type: "content", content: { type: "text", text: lines.join("\n") } }];
  }

  private formatState(state: SessionStatusState): string {
    switch (state) {
      case "running":
        return "Running";
      case "cancelled":
        return "Cancelled";
      case "error":
        return "Error";
      case "idle":
      default:
        return "Idle";
    }
  }
}
