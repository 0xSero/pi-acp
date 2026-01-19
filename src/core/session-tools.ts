import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { logWarn } from "../logger";
import type { SessionUpdate, ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import type { PiEvent } from "../pi/types";
import type { SessionState } from "./types";

type EmitUpdate = (sessionId: string, update: SessionUpdate) => void;

type ToolStartEvent = Extract<PiEvent, { type: "tool_execution_start" }>;
type ToolUpdateEvent = Extract<PiEvent, { type: "tool_execution_update" }>;
type ToolEndEvent = Extract<PiEvent, { type: "tool_execution_end" }>;

export class SessionToolHandler {
  private readonly emitUpdate: EmitUpdate;

  constructor(emitUpdate: EmitUpdate) {
    this.emitUpdate = emitUpdate;
  }

  async handleStart(session: SessionState, event: ToolStartEvent): Promise<void> {
    this.emitUpdate(session.id, {
      sessionUpdate: "tool_call",
      toolCallId: event.toolCallId,
      title: event.toolName,
      kind: this.mapToolKind(event.toolName),
      status: "pending",
      rawInput: event.args,
    });

    const path = this.extractPathFromArgs(event.args);
    if (path) {
      await this.snapshotFile(session, event.toolCallId, path);
    }
  }

  handleUpdate(session: SessionState, event: ToolUpdateEvent): void {
    const contentText = this.extractToolContent(event.partialResult);
    this.emitUpdate(session.id, {
      sessionUpdate: "tool_call_update",
      toolCallId: event.toolCallId,
      status: "in_progress",
      content: contentText ? [{ type: "content", content: { type: "text", text: contentText } }] : undefined,
    });
  }

  handleEnd(session: SessionState, event: ToolEndEvent): void {
    const contentText = this.extractToolContent(event.result);
    const diffContent = this.buildDiffContent(session, event.toolCallId);
    const content: ToolCallContent[] = [
      ...(contentText ? [{ type: "content" as const, content: { type: "text" as const, text: contentText } }] : []),
      ...(diffContent ? [diffContent] : []),
    ];

    this.emitUpdate(session.id, {
      sessionUpdate: "tool_call_update",
      toolCallId: event.toolCallId,
      status: event.isError ? "failed" : "completed",
      content: content.length > 0 ? content : undefined,
      rawOutput: event.result,
    });
  }

  private extractToolContent(result?: { content?: { type: "text"; text: string }[] }): string | undefined {
    if (!result?.content) {
      return undefined;
    }
    return result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
  }

  private extractPathFromArgs(args: unknown): string | undefined {
    if (!args || typeof args !== "object") {
      return undefined;
    }
    const candidate = args as { path?: unknown; filePath?: unknown; file?: unknown };
    const path = [candidate.path, candidate.filePath, candidate.file].find((value) => typeof value === "string");
    return typeof path === "string" ? path : undefined;
  }

  private async snapshotFile(session: SessionState, toolCallId: string, path: string): Promise<void> {
    if (!path.startsWith("/")) {
      return;
    }
    try {
      const oldText = await readFile(path, "utf8");
      session.toolCallSnapshots.set(toolCallId, { path, oldText });
    } catch (error) {
      logWarn(`snapshot failed for ${path}: ${(error as Error).message}`);
    }
  }

  private buildDiffContent(
    session: SessionState,
    toolCallId: string
  ): { type: "diff"; path: string; oldText?: string | null; newText: string } | null {
    const snapshot = session.toolCallSnapshots.get(toolCallId);
    if (!snapshot) {
      return null;
    }
    session.toolCallSnapshots.delete(toolCallId);
    const newText = this.readTextFileSync(snapshot.path);
    if (newText === null) {
      return null;
    }
    if (snapshot.oldText === newText) {
      return null;
    }
    return {
      type: "diff",
      path: snapshot.path,
      oldText: snapshot.oldText,
      newText,
    };
  }

  private readTextFileSync(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      logWarn(`read failed for ${path}: ${(error as Error).message}`);
      return null;
    }
  }

  private mapToolKind(toolName: string): ToolKind {
    const normalized = toolName.toLowerCase();
    if (normalized.includes("read")) {
      return "read";
    }
    if (normalized.includes("edit")) {
      return "edit";
    }
    if (normalized.includes("search")) {
      return "search";
    }
    if (normalized.includes("delete")) {
      return "delete";
    }
    if (normalized.includes("bash") || normalized.includes("exec")) {
      return "execute";
    }
    return "other";
  }
}
