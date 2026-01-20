import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";
import type { SessionState } from "../session/types";
import { extractCommandText, parseCommand } from "./parser";
import { createCommandActions, type CommandAction } from "./actions";

export class SessionCommandHandler {
  private readonly actions: Record<string, CommandAction>;

  constructor(emitUpdate: (sessionId: string, update: SessionUpdate) => void) {
    this.actions = createCommandActions(emitUpdate);
  }

  async handleSlashCommand(session: SessionState, prompt: ContentBlock[]): Promise<boolean> {
    const commandText = extractCommandText(prompt);
    if (!commandText) {
      return false;
    }
    const parsed = parseCommand(commandText);
    if (!parsed) {
      return false;
    }
    const action = this.actions[parsed.command];
    if (!action) {
      return false;
    }
    await action(session, parsed.args, prompt);
    return true;
  }
}
