import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { TransformStream } from "node:stream/web";
import { AcpAgent } from "./acp/agent";
import { SessionManager } from "./core/session/manager";
import { logInfo } from "./logger";

const sessionManager = new SessionManager();

const REQUIRED_MCP_METHODS = new Set(["session/new", "session/load", "session/resume", "session/fork"]);

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const baseStream = ndJsonStream(input, output);
const stream = {
  readable: baseStream.readable.pipeThrough(
    new TransformStream({
      transform(message, controller) {
        if (message && typeof message === "object" && "method" in message) {
          const method = (message as { method?: unknown }).method;
          if (typeof method === "string") {
            logInfo(`rpc:${method}`);
            if (REQUIRED_MCP_METHODS.has(method)) {
              const params = (message as { params?: Record<string, unknown> | null }).params ?? {};
              const mcpServers = (params as { mcpServers?: unknown }).mcpServers;
              if (!Array.isArray(mcpServers)) {
                (params as { mcpServers: unknown[] }).mcpServers = [];
              }
              (message as { params: Record<string, unknown> }).params = params;
            }
          }
        }
        controller.enqueue(message);
      },
    })
  ),
  writable: baseStream.writable,
};

new AgentSideConnection(
  (connection) => new AcpAgent(connection, sessionManager),
  stream,
);
