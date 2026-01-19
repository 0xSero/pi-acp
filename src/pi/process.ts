import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { logError, logInfo } from "../logger";
import {
  PiCommand,
  PiCommandWithId,
  PendingRequest,
  PiResponse,
  PiLine,
  PiProcessOptions,
} from "./types";

export class PiProcess {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly listeners: Array<(line: PiLine) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;

  constructor(options: PiProcessOptions) {
    const args = options.args ?? ["--mode", "rpc"];
    this.proc = spawn(options.piExecutable ?? "pi", args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: "pipe",
    });

    this.proc.on("error", (error) => {
      logError(`pi process error: ${error.message}`);
      this.errorListeners.forEach((listener) => listener(error));
    });

    this.proc.on("exit", (code, signal) => {
      logInfo(
        `pi process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      );
      this.rejectAllPending(new Error("pi process exited"));
    });

    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      try {
        const parsed = JSON.parse(trimmed) as PiLine;
        if ((parsed as PiResponse).type === "response") {
          const response = parsed as PiResponse;
          if (response.id) {
            const pending = this.pendingRequests.get(response.id);
            if (pending) {
              clearTimeout(pending.timeoutId);
              this.pendingRequests.delete(response.id);
              pending.resolve(response);
            }
          }
        }
        this.listeners.forEach((listener) => listener(parsed));
      } catch (error) {
        logError(`failed to parse pi rpc line: ${(error as Error).message}`);
      }
    });

    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      const trimmed = chunk.trim();
      if (trimmed.length > 0) {
        logInfo(`pi stderr: ${trimmed}`);
      }
    });
  }

  onLine(listener: (line: PiLine) => void): void {
    this.listeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  send(command: PiCommandWithId): void {
    const payload = JSON.stringify(command);
    this.proc.stdin.write(`${payload}\n`);
  }

  request(command: PiCommand, timeoutMs = 5000): Promise<PiResponse> {
    const id = `req_${++this.requestCounter}`;
    const payload: PiCommandWithId = { ...command, id };
    this.send(payload);

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Pi request timed out: ${command.type}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeoutId });
    });
  }

  stop(): void {
    this.proc.kill();
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }
}
