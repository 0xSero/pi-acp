import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const adapter = spawn("node", ["--import", "tsx", "src/index.ts"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "inherit"],
});

if (!adapter.stdout || !adapter.stdin) {
  throw new Error("Failed to spawn adapter with stdio pipes");
}

const rl = createInterface({ input: adapter.stdout });
let sessionId: string | null = null;

rl.on("line", (line: string) => {
  process.stdout.write(`[adapter] ${line}\n`);
  try {
    const parsed = JSON.parse(line) as { id?: number; result?: { sessionId?: string } };
    if (parsed.id === 2 && parsed.result?.sessionId) {
      sessionId = parsed.result.sessionId;
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text: "Hello" }],
        },
      });
    }
  } catch {
    // Ignore non-JSON output.
  }
});

function send(message: unknown) {
  adapter.stdin.write(`${JSON.stringify(message)}\n`);
}

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
send({
  jsonrpc: "2.0",
  id: 2,
  method: "session/new",
  params: {
    cwd: process.cwd(),
    mcpServers: [],
  },
});
