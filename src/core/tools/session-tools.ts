import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { logWarn } from "../../logger";
import type { SessionUpdate, ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import type { PiEvent } from "../../pi/types";
import type { SessionState } from "../session/types";

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
    const inputSummary = this.formatToolInput(event.toolName, event.args);
    const locations = this.extractLocations(event.args);
    session.toolCallInputs.set(event.toolCallId, { summary: inputSummary, locations });

    this.emitUpdate(session.id, {
      sessionUpdate: "tool_call",
      toolCallId: event.toolCallId,
      title: event.toolName,
      kind: this.mapToolKind(event.toolName),
      status: "pending",
      rawInput: event.args,
      locations: locations?.map((path) => ({ path })),
      content: inputSummary
        ? [{ type: "content", content: { type: "text", text: inputSummary } }]
        : undefined,
    });

    const path = this.extractPathFromArgs(event.args);
    if (path) {
      await this.snapshotFile(session, event.toolCallId, path);
    }
  }

  handleUpdate(session: SessionState, event: ToolUpdateEvent): void {
    const inputSummary = session.toolCallInputs.get(event.toolCallId)?.summary;
    const contentText = this.extractToolContent(event.partialResult);
    const content = this.buildToolCallContent(inputSummary, contentText, undefined);
    this.emitUpdate(session.id, {
      sessionUpdate: "tool_call_update",
      toolCallId: event.toolCallId,
      status: "in_progress",
      content: content.length > 0 ? content : undefined,
    });
  }

  handleEnd(session: SessionState, event: ToolEndEvent): void {
    const inputSummary = session.toolCallInputs.get(event.toolCallId)?.summary;
    session.toolCallInputs.delete(event.toolCallId);

    const contentText = this.extractToolContent(event.result);
    const detailsText = this.formatToolDetails(event.result?.details);
    const diffContent = this.buildDiffContent(session, event.toolCallId);
    const content = this.buildToolCallContent(inputSummary, contentText, detailsText);
    if (diffContent) {
      content.push(diffContent);
    }

    this.emitUpdate(session.id, {
      sessionUpdate: "tool_call_update",
      toolCallId: event.toolCallId,
      status: event.isError ? "failed" : "completed",
      content: content.length > 0 ? content : undefined,
      rawOutput: event.result,
    });
  }

  private buildToolCallContent(
    inputSummary?: string,
    outputText?: string,
    detailsText?: string
  ): ToolCallContent[] {
    const parts = [inputSummary, outputText, detailsText].filter(Boolean) as string[];
    if (parts.length === 0) {
      return [];
    }
    return [{ type: "content", content: { type: "text", text: parts.join("\n\n") } }];
  }

  private formatToolInput(toolName: string, args: unknown): string {
    if (toolName.toLowerCase() === "bash" && args && typeof args === "object") {
      const command = (args as { command?: unknown }).command;
      if (typeof command === "string") {
        return `Command: ${command}`;
      }
    }
    if (!args) {
      return toolName;
    }
    try {
      return `Args: ${JSON.stringify(args, null, 2)}`;
    } catch {
      return `Args: ${String(args)}`;
    }
  }

  private formatToolDetails(details?: Record<string, unknown>): string | undefined {
    if (!details || Object.keys(details).length === 0) {
      return undefined;
    }
    return `Details: ${JSON.stringify(details, null, 2)}`;
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

  private extractLocations(args: unknown): string[] | undefined {
    const path = this.extractPathFromArgs(args);
    return path ? [path] : undefined;
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
    if (normalized.includes("fetch") || normalized.includes("http")) {
      return "fetch";
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
