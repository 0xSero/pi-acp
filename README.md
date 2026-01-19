# pi-acp

> Agent Client Protocol (ACP) adapter for pi `--mode rpc`

[Agent Client Protocol](https://github.com/agentclientprotocol/sdk) (ACP) is a standardized protocol for AI agent clients and servers. This adapter enables the [pi coding agent](https://github.com/mariozechner/pi) to communicate with any ACP-compatible client, providing a robust bridge between pi's RPC mode and the ACP ecosystem.

## 🎯 Overview

`pi-acp` is a TypeScript/Node.js adapter that:
- Spawns and manages pi processes in RPC mode
- Translates ACP protocol messages to pi RPC commands
- Manages multi-session conversations with full state persistence
- Exposes pi's capabilities through ACP's standardized interface
- Provides streaming responses, tool execution, and configuration management

### Architecture

```
┌─────────────────┐     NDJSON over     ┌─────────────────┐
│  ACP Client     │ ◄──────────────────► │   pi-acp        │
│  (IDE, UI, etc) │      stdin/stdout     │   (this repo)   │
└─────────────────┘                      └────────┬────────┘
                                                  │
                                                  │ RPC commands
                                                  ▼
                                          ┌─────────────────┐
                                          │   pi process    │
                                          │  (--mode rpc)   │
                                          └─────────────────┘
```

## ✨ Features

- **Full ACP Implementation**: Implements all core ACP methods including session management, prompting, and configuration
- **Multi-Session Support**: Create, load, list, and resume multiple pi sessions concurrently
- **Streaming Responses**: Real-time streaming of pi's output through ACP session updates
- **Tool Execution**: Transparent handling of pi's tool calls (file operations, bash commands, etc.)
- **Slash Commands**: Exposes pi's built-in commands (`compact`, `model`, `thinking`, etc.)
- **Configuration Sync**: Bidirectional sync of models, thinking levels, and other settings
- **Session Persistence**: Automatic session file tracking and recovery
- **Image Support**: Pass images through to pi for vision-enabled models
- **Graceful Cancellation**: Prompt cancellation with proper cleanup

## 📦 Installation

### Prerequisites

- Node.js 18+ with ES2022 support
- pi coding agent installed and available in your PATH
- TypeScript 5+ (for development)

### Install Dependencies

```bash
cd pi-rpc-acp-adapter
npm install
```

## 🚀 Usage

### Running the Adapter

The adapter communicates over stdin/stdout using NDJSON (newline-delimited JSON), which is the standard transport for ACP:

```bash
npm start
```

This starts the adapter, which will:
1. Listen for ACP messages on stdin
2. Spawn pi processes as needed
3. Respond with ACP messages on stdout

### Integration with ACP Clients

Any ACP-compatible client can connect to pi-acp by piping stdin/stdout. For example, with a reference client:

```bash
acp-client | node --import tsx src/index.ts | acp-client
```

## 🏗️ Project Structure

```
pi-rpc-acp-adapter/
├── src/
│   ├── index.ts                 # Entry point, sets up ACP connection
│   ├── logger.ts                # Logging utilities
│   ├── acp/
│   │   └── agent.ts             # AcpAgent class implementing the Agent interface
│   ├── pi/
│   │   ├── process.ts           # PiProcess class for spawning/managing pi
│   │   └── types.ts             # Pi RPC type definitions
│   └── core/
│       ├── session-manager.ts   # Multi-session lifecycle management
│       ├── session-runtime.ts   # Message handling and slash commands
│       ├── session-config.ts    # Config/model resolution and sync
│       ├── session-consts.ts    # Constants and default commands
│       └── types.ts             # Shared type definitions
├── scripts/
│   ├── smoke.ts                 # Basic smoke test
│   └── demo-client.ts           # Demo ACP client for testing
├── package.json
├── tsconfig.json
└── README.md
```

## 🔌 Core Components

### AcpAgent (`src/acp/agent.ts`)

Implements the ACP `Agent` interface, handling all protocol messages:

- **initialize**: Negotiates protocol version and reports capabilities
- **authenticate**: Returns empty (pi has no auth)
- **newSession**: Creates a fresh pi session with unique ID
- **loadSession**: Loads an existing pi session from disk
- **resumeSession**: Reconnects to an active session
- **prompt**: Sends user prompts to pi and returns stop reasons
- **cancel**: Interrupts in-progress prompts
- **unstable_setSessionModel**: Switches the active model
- **unstable_setSessionConfigOption**: Updates config (thinking level, steering, etc.)
- **unstable_listSessions**: Lists all active sessions

### SessionManager (`src/core/session-manager.ts`)

Manages the lifecycle of pi sessions:

- Tracks all active sessions in memory
- Spawns `PiProcess` instances for each session
- Maintains a session map file at `~/.pi/pi-acp/session-map.json`
- Routes prompts to the correct session
- Handles session persistence and recovery
- Emits session updates back to the ACP client

### PiProcess (`src/pi/process.ts`)

Wraps a pi subprocess in RPC mode:

- Spawns pi with `--mode rpc` flag
- Communicates via newline-delimited JSON over stdin/stdout
- Implements request/response pattern with timeouts
- Streams all output lines to registered listeners
- Handles process errors and exits gracefully

### SessionRuntime (`src/core/session-runtime.ts`)

Handles the translation between ACP and pi messages:

- Converts ACP `ContentBlock[]` prompts to pi RPC format
- Parses pi output and emits ACP session updates
- Handles slash commands (`/compact`, `/model`, `/thinking`, etc.)
- Tracks tool calls and creates snapshots for edits
- Replays conversation history when loading sessions

## 📝 ACP Protocol Mapping

| ACP Method | Pi RPC Command |
|------------|----------------|
| `newSession` | Spawn new pi process |
| `loadSession` | `switch_session` to existing session file |
| `prompt` | `prompt` with message content |
| `cancel` | `abort` |
| `setSessionModel` | `set_model` |
| `setConfigOption(thinking_level)` | `set_thinking_level` |
| `setConfigOption(steering_mode)` | `set_steering_mode` |
| `setConfigOption(auto_compaction)` | `set_auto_compaction` |

## 🛠️ Configuration

### Environment Variables

The adapter respects these environment variables when spawning pi:

- `PI_EXECUTABLE`: Path to pi binary (default: `"pi"`)
- `PI_ARGS`: Additional arguments to pass to pi (default: `["--mode", "rpc"]`)

### Session Storage

Session state is managed by pi itself. The adapter tracks session file locations in:

```
~/.pi/pi-acp/session-map.json
```

This mapping allows sessions to be reloaded across adapter restarts.

## 🧪 Development

### Type Checking

```bash
npm run typecheck
```

### Running Tests

```bash
npm test
```

This runs the smoke test which verifies basic adapter functionality.

### Demo Client

A minimal ACP client is provided for testing:

```bash
node --import tsx scripts/demo-client.ts | npm start | node --import tsx scripts/demo-client.ts
```

## 🔍 Message Flow Example

```
Client                    pi-acp                    pi
│                         │                         │
├─ initialize ────────────►│                         │
│◄── capabilities ─────────┤                         │
│                         │                         │
├─ newSession ───────────►│  ──spawn pi──────────►  │
│◄── sessionId ───────────┤                         │
│                         │                         │
├─ prompt("Hello") ──────►│  ──prompt("Hello")───►  │
│◄── sessionUpdate ───────┤◄─ streaming output ─────┤
│    (thinking)           │                         │
│◄── sessionUpdate ───────┤                         │
│    (tool call)          │                         │
│◄── sessionUpdate ───────┤                         │
│    (response text)      │                         │
│◄── prompt(end_turn) ────┤◄─ done ─────────────────┤
│                         │                         │
├─ setSessionModel ──────►│  ──set_model ─────────►│
│◄── configOptions ───────┤◄─ new model info ───────┤
```

## 🐛 Troubleshooting

### pi process not found

Ensure pi is installed and in your PATH:

```bash
which pi
pi --version
```

### Session not loading

Check the session map file:

```bash
cat ~/.pi/pi-acp/session-map.json
```

### Verbose logging

The adapter logs to stderr. Redirect to see debug output:

```bash
npm start 2>debug.log
```

## 📄 License

MIT

## 🤝 Contributing

Contributions welcome! Please ensure:
- TypeScript types are strict and accurate
- All changes preserve ACP protocol compliance
- Tests pass before submitting PRs
- Code follows existing patterns and conventions

## 🔗 Related Projects

- [Agent Client Protocol SDK](https://github.com/agentclientprotocol/sdk) - The protocol specification
- [pi](https://github.com/mariozechner/pi) - The AI coding agent this adapter connects to
- [pi documentation](https://github.com/mariozechner/pi/blob/master/README.md) - Full pi capabilities reference
