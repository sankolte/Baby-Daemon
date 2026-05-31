# MCP (Model Context Protocol) — Complete Deep Dive

> Everything you need to know before wrapping Baby Daemon as an MCP server (Phase 5).

---

## Table of Contents

1. [The Problem MCP Solves](#the-problem-mcp-solves)
2. [What IS MCP?](#what-is-mcp)
3. [The Architecture (3 Layers)](#the-architecture-3-layers)
4. [JSON-RPC 2.0 — The Wire Format](#json-rpc-20--the-wire-format)
5. [Transport Layer — How Bytes Actually Move](#transport-layer--how-bytes-actually-move)
6. [The 3 MCP Primitives](#the-3-mcp-primitives)
7. [Lifecycle — What Happens From Start to Finish](#lifecycle--what-happens-from-start-to-finish)
8. [Byte-Level Walkthrough: A Tool Call](#byte-level-walkthrough-a-tool-call)
9. [How This Maps to Baby Daemon](#how-this-maps-to-baby-daemon)
10. [MCP vs REST API — Why Not Just Use HTTP?](#mcp-vs-rest-api--why-not-just-use-http)
11. [Security Considerations](#security-considerations)

---

## The Problem MCP Solves

Before MCP, the AI tool ecosystem had an **N×M integration problem**.

```
Without MCP:
┌──────────────┐     ┌──────────────┐
│  Claude      │────▶│  GitHub API  │  custom connector 1
│  Desktop     │────▶│  Slack API   │  custom connector 2
│              │────▶│  Your DB     │  custom connector 3
└──────────────┘     └──────────────┘

┌──────────────┐     ┌──────────────┐
│  Cursor      │────▶│  GitHub API  │  custom connector 4 (DUPLICATE!)
│              │────▶│  Slack API   │  custom connector 5 (DUPLICATE!)
│              │────▶│  Your DB     │  custom connector 6 (DUPLICATE!)
└──────────────┘     └──────────────┘

┌──────────────┐     ┌──────────────┐
│  Cline       │────▶│  GitHub API  │  custom connector 7 (DUPLICATE!)
│              │────▶│  Slack API   │  custom connector 8 (DUPLICATE!)
│              │────▶│  Your DB     │  custom connector 9 (DUPLICATE!)
└──────────────┘     └──────────────┘

3 hosts × 3 tools = 9 custom integrations
```

If you had 10 AI apps and 20 tools, you'd need **200 custom connectors**. Every app has to know how to talk to every tool differently. That's insane.

```
With MCP:
┌──────────────┐         ┌──────────────┐
│  Claude      │──MCP──▶│  GitHub MCP  │  1 server, works with ALL hosts
│  Desktop     │         │  Server      │
└──────────────┘         └──────────────┘
                         ┌──────────────┐
┌──────────────┐──MCP──▶│  Slack MCP   │  1 server, works with ALL hosts
│  Cursor      │         │  Server      │
└──────────────┘         └──────────────┘
                         ┌──────────────┐
┌──────────────┐──MCP──▶│  Your DB MCP │  1 server, works with ALL hosts
│  Cline       │         │  Server      │
└──────────────┘         └──────────────┘

3 hosts + 3 servers = 6 components (not 9 connectors)
```

With 10 hosts and 20 tools: just **30 components** instead of 200.

> **The USB-C analogy**: Before USB-C, every phone brand had its own charger. USB-C is one universal port. MCP is USB-C for AI tools.

---

## What IS MCP?

> [!IMPORTANT]
> **MCP (Model Context Protocol)** is an **open standard** created by Anthropic that defines a universal protocol for AI applications to discover and interact with external tools, data sources, and prompt templates.

In plain terms:

- It's a **communication protocol** (like HTTP, but specifically designed for AI ↔ Tool interaction)
- It uses **JSON-RPC 2.0** as its message format (we'll explain this below)
- It runs over **stdio** (local pipes) or **HTTP** (remote network)
- It's **bidirectional** — both client and server can send messages to each other
- It's **stateful** — there's a connection lifecycle (init → operate → shutdown)

Think of it as a **contract**. If your tool speaks MCP, ANY MCP-compatible AI host can use it. If your AI host speaks MCP, it can use ANY MCP server.

---

## The Architecture (3 Layers)

MCP has 3 key roles:

```
┌─────────────────────────────────────────────────────┐
│                    MCP HOST                          │
│  (The AI application — Claude Desktop, Cursor, etc.) │
│                                                      │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐    │
│  │ MCP Client │  │ MCP Client │  │ MCP Client │    │
│  │     #1     │  │     #2     │  │     #3     │    │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘    │
│        │               │               │            │
└────────┼───────────────┼───────────────┼────────────┘
         │               │               │
         ▼               ▼               ▼
   ┌───────────┐   ┌───────────┐   ┌───────────┐
   │ MCP Server│   │ MCP Server│   │ MCP Server│
   │ (GitHub)  │   │ (Slack)   │   │ (Baby     │
   │           │   │           │   │  Daemon!) │
   └───────────┘   └───────────┘   └───────────┘
```

### 1. Host
- **What**: The AI application the user interacts with (Claude Desktop, Cursor, Cline, VS Code, etc.)
- **Role**: Coordinates everything. Contains the LLM, the UI, and manages multiple MCP clients
- **Analogy**: Your computer/laptop

### 2. Client
- **What**: A component *inside* the host that maintains a **1:1 connection** to a single MCP server
- **Role**: Sends requests to the server, receives responses, handles capability negotiation
- **Key detail**: Each server gets its own dedicated client. If the host talks to 3 servers, it creates 3 clients
- **Analogy**: A USB-C port on your laptop (one port per device)

### 3. Server
- **What**: A lightweight program that **exposes** specific capabilities (tools, data, prompts)
- **Role**: Listens for requests, executes them, returns results
- **This is what you'll build**: Baby Daemon will become an MCP server!
- **Analogy**: The device you plug into the USB-C port (a hard drive, monitor, etc.)

---

## JSON-RPC 2.0 — The Wire Format

> [!NOTE]
> JSON-RPC is the **language** that MCP messages are written in. It's a super simple protocol for remote procedure calls using JSON.

Before we get into MCP specifics, you MUST understand JSON-RPC 2.0 because every single MCP message is a JSON-RPC message.

### What is RPC?

**RPC = Remote Procedure Call**

It means: "I want to call a function on another computer/process, as if it were a local function."

```javascript
// Local function call:
const result = add(2, 3);  // returns 5

// Remote procedure call (conceptually the same):
// You send a message to another process saying "run add(2, 3)"
// That process runs it and sends back 5
```

### The 3 Message Types

JSON-RPC 2.0 has exactly 3 types of messages:

#### 1. Request (Client → Server, expects a response)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "memory_search",
    "arguments": {
      "query": "auth bug yesterday"
    }
  }
}
```

| Field | Purpose |
|-------|---------|
| `jsonrpc` | Always `"2.0"`. Protocol version identifier |
| `id` | A unique ID so the client can match the response to this request |
| `method` | The function name to call on the server |
| `params` | The arguments to pass to that function |

#### 2. Response (Server → Client, answering a request)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Auth bug was caused by expired JWT secret. Fixed by rotating keys."
      }
    ]
  }
}
```

| Field | Purpose |
|-------|---------|
| `id` | Must match the request's `id` (that's how the client knows which request this answers) |
| `result` | The return value (present on success) |
| `error` | An error object (present on failure, mutually exclusive with `result`) |

#### 3. Notification (fire-and-forget, NO response expected)

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

> [!TIP]
> **How to tell a Notification from a Request**: Notifications have **NO `id` field**. No `id` = "don't bother responding."

### Error Response Example

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "Invalid params: 'query' is required"
  }
}
```

### Why JSON-RPC and Not Just Plain JSON?

Because JSON-RPC gives you:
- **Request-response correlation** via `id` (critical for async communication)
- **Standardized error format** (error codes, messages)
- **Notifications** (one-way messages without response overhead)
- **Language-agnostic** (any language that can parse JSON can speak JSON-RPC)

---

## Transport Layer — How Bytes Actually Move

> [!IMPORTANT]
> JSON-RPC defines the **message format**. Transport defines **how those messages physically travel** between client and server.

MCP is **transport-agnostic** — it can work over multiple transport mechanisms. Think of it like email: the content format (email body) is the same whether you send it via Gmail or Outlook. Currently there are 2 main transports:

### Transport 1: STDIO (Local — This is what you'll use)

```
┌─────────────────────┐          ┌─────────────────────┐
│     MCP HOST        │          │     MCP SERVER      │
│   (Claude Desktop)  │          │   (Baby Daemon)     │
│                     │          │                     │
│  Spawns server as   │  stdin   │                     │
│  a CHILD PROCESS ──────────▶  │  Reads from stdin   │
│                     │          │  (JSON-RPC messages) │
│                     │  stdout  │                     │
│  Reads from stdout  │◀──────── │  Writes to stdout   │
│  (JSON-RPC messages)│          │  (JSON-RPC messages) │
│                     │          │                     │
│                     │  stderr  │                     │
│  (optional logging) │◀──────── │  Debug logs go here  │
│                     │          │                     │
└─────────────────────┘          └─────────────────────┘
```

#### How does this ACTUALLY work at the OS level?

1. **The host starts the server as a child process:**
   ```
   Claude Desktop runs: node baby-daemon-mcp.js
   ```
   This is exactly like when you run `node something.js` in your terminal. The OS creates a new process.

2. **The OS creates pipes:**
   When a parent process spawns a child process, the OS automatically creates **three pipes**:
   - `stdin` (standard input): parent → child
   - `stdout` (standard output): child → parent
   - `stderr` (standard error): child → parent (for logs)

   These are just **byte streams in memory**. Like a tube connecting two rooms.

3. **Message framing:**
   Since stdin/stdout are continuous byte streams (no natural boundaries), MCP uses a simple rule:

   > **Each JSON-RPC message = one line of UTF-8 text, terminated by `\n`**

   So the raw bytes flowing through stdout look like:
   ```
   {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Found 3 memories"}]}}\n
   {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n
   ```

   The client reads line by line. Each line = one complete JSON-RPC message.

4. **No network involved:**
   This is all happening **inside your computer's memory**. No TCP, no HTTP, no ports, no sockets. Just OS-level inter-process communication (IPC) through pipes. That's why it's blazing fast.

#### What happens in your code:

```javascript
// SERVER SIDE (your Baby Daemon MCP server)
// The SDK handles this for you, but under the hood:
process.stdin   // ← reads incoming JSON-RPC requests
process.stdout  // ← writes JSON-RPC responses
process.stderr  // ← writes debug logs (optional)
```

```javascript
// CLIENT SIDE (Claude Desktop, internally)
const child = child_process.spawn('node', ['baby-daemon-mcp.js']);
child.stdin.write(JSON.stringify(request) + '\n');  // send request
child.stdout.on('data', (data) => {                 // receive response
  const response = JSON.parse(data.toString());
});
```

### Transport 2: Streamable HTTP (Remote)

Used when the server is on a different machine (cloud, SaaS, etc.)

```
┌─────────────────┐                          ┌─────────────────┐
│   MCP HOST      │     HTTP POST            │   MCP SERVER    │
│   (Claude)      │ ──────────────────────▶  │   (Cloud)       │
│                 │  Content-Type:           │                 │
│                 │  application/json        │                 │
│                 │                          │                 │
│                 │     HTTP Response        │                 │
│                 │ ◀──────────────────────  │                 │
│                 │  (or SSE stream)         │                 │
│                 │                          │                 │
│                 │     GET /sse             │                 │
│                 │ ◀─────────────────────── │  Server pushes  │
│                 │  (Server-Sent Events     │  notifications  │
│                 │   for async notifs)      │  via SSE stream │
└─────────────────┘                          └─────────────────┘
```

- **Client → Server**: HTTP POST with JSON-RPC body
- **Server → Client**: Either direct HTTP response, OR upgrade to SSE (Server-Sent Events) stream for async messages
- **Session management**: Uses a session ID header because HTTP is stateless but MCP needs statefulness
- **You won't need this** for Baby Daemon (it's local), but good to know

### Comparison Table

| Feature | STDIO | Streamable HTTP |
|---------|-------|-----------------|
| **Where** | Same machine | Any machine (network) |
| **How** | OS pipes (stdin/stdout) | HTTP requests + SSE |
| **Latency** | Microseconds (no network) | Milliseconds (network stack) |
| **Setup** | Host spawns server process | Server runs as web service |
| **Scalability** | 1:1 (one client per process) | Many clients to one server |
| **Security** | OS-level process isolation | TLS, auth tokens, CORS |
| **Use case** | Desktop IDEs, CLI tools | Cloud services, SaaS tools |
| **Your Baby Daemon** | ✅ This one | Not needed for now |

---

## The 3 MCP Primitives

MCP servers expose capabilities through exactly **3 primitives**:

```
┌─────────────────────────────────────────────────┐
│                 MCP SERVER                       │
│                                                  │
│  ┌─────────┐  ┌───────────┐  ┌─────────┐       │
│  │  TOOLS  │  │ RESOURCES │  │ PROMPTS │       │
│  │         │  │           │  │         │       │
│  │ Actions │  │   Data    │  │Templates│       │
│  │ the AI  │  │   the AI  │  │ for the │       │
│  │ can DO  │  │   can READ│  │ AI to   │       │
│  │         │  │           │  │ use     │       │
│  └─────────┘  └───────────┘  └─────────┘       │
│                                                  │
└─────────────────────────────────────────────────┘
```

### 1. Tools — "Functions the AI can call"

This is the **most important** primitive for Baby Daemon.

Tools are like API endpoints that the AI can invoke. The AI reads the tool's description and schema, decides when to use it, and calls it with the right arguments.

```json
// Tool definition (what the server advertises):
{
  "name": "memory_search",
  "description": "Search through project memories using semantic similarity. Returns relevant past decisions, bugs, and architecture notes.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Natural language search query"
      },
      "limit": {
        "type": "number",
        "description": "Max results to return (default 5)"
      }
    },
    "required": ["query"]
  }
}
```

```json
// Tool invocation (what the AI sends):
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "tools/call",
  "params": {
    "name": "memory_search",
    "arguments": {
      "query": "What was the auth bug yesterday?",
      "limit": 3
    }
  }
}
```

```json
// Tool result (what the server responds):
{
  "jsonrpc": "2.0",
  "id": 42,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Found 2 relevant memories:\n1. [decision] JWT secret was expiring due to misconfigured rotation. Fixed by updating .env.\n2. [bug] Auth middleware was not checking token expiry correctly."
      }
    ]
  }
}
```

> [!TIP]
> **Critical insight**: The `description` is everything. The LLM reads the description to decide WHEN and HOW to use the tool. A bad description = the AI never uses your tool or uses it wrong.

### 2. Resources — "Data the AI can read"

Resources are read-only data sources. Think of them like files or database views that the AI can access.

```json
// Resource definition:
{
  "uri": "memory://recent",
  "name": "Recent Memories",
  "description": "The 10 most recent memory entries",
  "mimeType": "application/json"
}
```

Unlike tools, resources are typically **pulled by the user/client** (not auto-invoked by the LLM). Example: the user says "show me recent memories" and the client reads the resource.

### 3. Prompts — "Reusable prompt templates"

Prompts are pre-written templates that help the AI behave in a specific way.

```json
// Prompt definition:
{
  "name": "continue_from_memory",
  "description": "Load relevant project memory and continue coding from where the last agent left off",
  "arguments": [
    {
      "name": "task",
      "description": "What you want to work on",
      "required": true
    }
  ]
}
```

When invoked, the server returns a pre-crafted prompt that includes memory context:

```json
{
  "messages": [
    {
      "role": "user",
      "content": {
        "type": "text",
        "text": "You are continuing a project. Here is the relevant context from previous sessions:\n\n1. Auth was migrated to OAuth...\n2. Frontend uses React 18...\n\nPlease continue with: implement payment flow"
      }
    }
  ]
}
```

### For Baby Daemon, you'll mainly use **Tools**:

| Baby Daemon Feature | MCP Primitive | Tool Name |
|---------------------|---------------|-----------|
| `memory search <query>` | Tool | `memory_search` |
| `memory store <content>` | Tool | `memory_store` |
| `memory dump --since` | Tool | `memory_dump` |
| `memory status` | Resource | `memory://status` |
| `memory watch` | Tool | `memory_watch_start` |
| Context injection prompt | Prompt | `continue_from_memory` |

---

## Lifecycle — What Happens From Start to Finish

The MCP connection goes through **3 phases**:

```
Phase 1: INITIALIZATION           Phase 2: OPERATION              Phase 3: SHUTDOWN
┌───────────────────────┐     ┌───────────────────────┐     ┌──────────────────┐
│                       │     │                       │     │                  │
│  Client ──initialize──▶ Server  │  Client ──tools/list──▶ Server  │  Client kills    │
│         (version +    │     │         (discover)    │     │  the server      │
│          capabilities)│     │                       │     │  process         │
│                       │     │  Client ──tools/call──▶ Server  │                  │
│  Client ◀──response── Server  │         (execute)     │     │  OR              │
│         (server caps) │     │                       │     │                  │
│                       │     │  Client ◀──result──── Server  │  Server sends    │
│  Client ──initialized─▶ Server│         (response)    │     │  close notif     │
│         (notification)│     │                       │     │                  │
│                       │     │  Server ──notification─▶ Client│                  │
│  ✅ Ready to operate  │     │         (tools changed)│     │                  │
└───────────────────────┘     └───────────────────────┘     └──────────────────┘
```

### Phase 1: Initialization (The Handshake)

This is like a TCP handshake but for MCP. It's **mandatory** — no other messages can be sent until this completes.

**Step 1**: Client sends `initialize` request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {
      "roots": { "listChanged": true },
      "sampling": {}
    },
    "clientInfo": {
      "name": "claude-desktop",
      "version": "1.5.0"
    }
  }
}
```

What's happening:
- **Protocol version**: "I speak MCP version 2025-03-26, do you?"
- **Capabilities**: "Here's what I (the client) can do" — e.g., I support `roots` (file system roots) and `sampling` (LLM inference)
- **Client info**: "I'm Claude Desktop v1.5.0"

**Step 2**: Server responds with its capabilities:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-03-26",
    "capabilities": {
      "tools": { "listChanged": true },
      "resources": { "subscribe": true },
      "prompts": { "listChanged": true }
    },
    "serverInfo": {
      "name": "baby-daemon",
      "version": "1.0.0"
    }
  }
}
```

What's happening:
- **Protocol version match**: "Yes, I speak the same version"
- **Capabilities**: "Here's what I (the server) offer" — tools, resources, prompts
- **`listChanged: true`**: "I can notify you when my list of tools changes dynamically"

**Step 3**: Client sends `initialized` notification:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

This is a notification (no `id`), meaning: "I acknowledge, we're good to go."

> [!NOTE]
> **Capability negotiation is like a job interview.** The client says "I can do X, Y, Z" and the server says "I can do A, B, C." Both sides now know exactly what the other supports. This prevents a server from trying to use a feature the client doesn't support.

### Phase 2: Operation

Now the fun begins. The client can:

1. **Discover tools**: `tools/list` → server returns all available tools with schemas
2. **Call tools**: `tools/call` → server executes and returns results
3. **Read resources**: `resources/read` → server returns data
4. **Use prompts**: `prompts/get` → server returns prompt template

The server can also:
- Send **notifications** to the client (e.g., "my tool list changed, re-fetch it!")
- Request **sampling** from the client (ask the host's LLM to generate text — advanced feature)

### Phase 3: Shutdown

Either side can close the connection. For stdio, the host simply kills the child process. For HTTP, a close notification is sent.

---

## Byte-Level Walkthrough: A Tool Call

Let's trace EXACTLY what happens when Claude Desktop calls your Baby Daemon's `memory_search` tool:

```
                          TIME
                           │
                           ▼
┌───────────────┐                    ┌───────────────┐
│ Claude Desktop│                    │ Baby Daemon   │
│ (Host/Client) │                    │ (MCP Server)  │
└───────┬───────┘                    └───────┬───────┘
        │                                     │
        │  1. User asks: "What was the        │
        │     auth bug yesterday?"            │
        │                                     │
        │  2. LLM sees memory_search tool     │
        │     and decides to call it           │
        │                                     │
        │  3. Client writes to stdin pipe:     │
        │  ┌─────────────────────────────────┐│
        │  │ {"jsonrpc":"2.0","id":42,       ││
        │  │  "method":"tools/call",         ││
        │  │  "params":{"name":"memory_      ││
        │  │  search","arguments":{"query":  ││
        │  │  "auth bug yesterday"}}}\n      ││
        │  └─────────────────────────────────┘│
        │ ─────────────stdin──────────────▶   │
        │                                     │
        │                    4. Server reads  │
        │                       the line from │
        │                       stdin         │
        │                                     │
        │                    5. Server parses  │
        │                       JSON-RPC msg  │
        │                                     │
        │                    6. Server sees    │
        │                       method =      │
        │                       "tools/call"  │
        │                       name =        │
        │                       "memory_      │
        │                       search"       │
        │                                     │
        │                    7. Server calls   │
        │                       YOUR search   │
        │                       function:     │
        │                       vectorStore   │
        │                       .search(      │
        │                       "auth bug     │
        │                       yesterday")   │
        │                                     │
        │                    8. LanceDB does  │
        │                       vector search │
        │                       Returns top 3 │
        │                       matches       │
        │                                     │
        │                    9. Server writes  │
        │                       to stdout:    │
        │  ┌─────────────────────────────────┐│
        │  │ {"jsonrpc":"2.0","id":42,       ││
        │  │  "result":{"content":[{"type":  ││
        │  │  "text","text":"Found 2 results ││
        │  │  ..."}]}}\n                     ││
        │  └─────────────────────────────────┘│
        │  ◀────────────stdout───────────────  │
        │                                     │
        │  10. Client reads the line          │
        │      from stdout                    │
        │                                     │
        │  11. Client matches id=42 to        │
        │      the original request           │
        │                                     │
        │  12. Client passes result to LLM    │
        │                                     │
        │  13. LLM incorporates memory        │
        │      into its response to user      │
        │                                     │
```

### At the OS level, step 3 looks like this:

```
Process: claude-desktop (PID 1234)
  │
  ├── child_process.spawn('node', ['baby-daemon-mcp.js'])
  │     Creates process: baby-daemon-mcp (PID 5678)
  │
  │  Pipe: PID 1234 stdout fd → PID 5678 stdin fd
  │  Pipe: PID 5678 stdout fd → PID 1234 reading fd
  │
  ├── Writes bytes to pipe:
  │   7B 22 6A 73 6F 6E 72 70 63 22 3A ...  (the JSON string as UTF-8 bytes)
  │   ... 7D 0A  (closing brace + newline \n)
  │
  └── Baby Daemon's Node.js runtime reads these bytes from process.stdin
      Assembles them into a string, splits on \n, parses JSON
```

The `0A` byte at the end is the newline character (`\n`). That's the **frame delimiter** — it tells the reader "this is the end of one complete message."

---

## How This Maps to Baby Daemon

Your project already has all the building blocks. Phase 5 is about **wrapping them as MCP tools**.

```
Current Baby Daemon (CLI):                MCP Server version:

$ memory-watch                    →    tool: memory_watch_start
$ memory search "auth bug"        →    tool: memory_search
$ memory dump --since yesterday   →    tool: memory_dump
$ memory status                   →    resource: memory://status

src/watcher.js                    →    registers as background process
src/vectorStore.js                →    called by memory_search tool
src/summarizer.js                 →    called by watcher internally
src/memoryStore.js                →    called by memory_store tool
```

### How the MCP server code will look:

```javascript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Import your existing Baby Daemon modules
import { search } from "./src/vectorStore.js";
import { getRecentMemories } from "./src/memoryStore.js";

// 1. Create the MCP server
const server = new McpServer({
  name: "baby-daemon",
  version: "1.0.0",
});

// 2. Register your existing functionality as MCP tools

// memory search → MCP tool
server.registerTool(
  "memory_search",
  {
    description: "Search project memories using semantic similarity. Finds past decisions, bugs, fixes, and architecture notes from previous coding sessions.",
    inputSchema: z.object({
      query: z.string().describe("Natural language search query"),
      limit: z.number().optional().describe("Max results (default 5)"),
    }),
  },
  async ({ query, limit = 5 }) => {
    const results = await search(query, limit);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(results, null, 2)
      }]
    };
  }
);

// memory dump → MCP tool
server.registerTool(
  "memory_dump",
  {
    description: "Dump raw memory entries, optionally filtered by time. Use this as a fallback when semantic search isn't working well.",
    inputSchema: z.object({
      since: z.string().optional().describe("ISO date string to filter from"),
    }),
  },
  async ({ since }) => {
    const memories = await getRecentMemories(since);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(memories, null, 2)
      }]
    };
  }
);

// 3. Connect to stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
```

### How Claude Desktop would use it:

In Claude Desktop's config (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "baby-daemon": {
      "command": "node",
      "args": ["C:\\Users\\kolte\\OneDrive\\Desktop\\proj101\\mcp-server.js"]
    }
  }
}
```

That's it. Claude Desktop now:
1. Spawns `node mcp-server.js` as a child process
2. Does the initialization handshake
3. Discovers your tools (`memory_search`, `memory_dump`)
4. The LLM can now call them whenever it needs context

---

## MCP vs REST API — Why Not Just Use HTTP?

You might wonder: "Why can't I just make a REST API with Express.js?"

| Feature | REST API | MCP |
|---------|----------|-----|
| **Discovery** | You must read docs, hardcode endpoints | AI auto-discovers tools via `tools/list` |
| **Schema** | OpenAPI/Swagger (optional, often missing) | Built-in JSON Schema for every tool (mandatory) |
| **Bidirectional** | Client → Server only | Both directions (server can push notifications, request sampling) |
| **Stateful** | Stateless by design | Stateful session with lifecycle |
| **AI-native** | AI needs custom prompt engineering per API | AI reads tool descriptions, uses tools natively |
| **Universal** | Every API is different | Every MCP server follows the same protocol |
| **Integration** | Custom code per AI host | Drop-in config for any MCP-compatible host |
| **Transport** | HTTP only | stdio (fast local) or HTTP |

> [!IMPORTANT]
> The killer feature: **with MCP, you write ONE server and EVERY AI tool (Claude, Cursor, Cline, Windsurf, etc.) can use it instantly.** With REST, you'd need to teach each AI separately how to use your API.

---

## Security Considerations

> [!WARNING]
> MCP servers run with the same permissions as the user. A malicious MCP server could read your files, make network requests, or execute arbitrary code.

Key security principles:

1. **Trust boundary**: Only install MCP servers you trust (same as npm packages)
2. **Capability negotiation**: During init, the server declares what it needs. The client should validate and limit this
3. **Tool approval**: Some hosts (like Claude Desktop) ask the user for confirmation before executing tools
4. **Input validation**: Always validate tool inputs (the Zod schemas in the SDK help with this)
5. **Confused deputy problem**: A server could trick the client into doing things on its behalf. The client must enforce permission boundaries

---

## Summary — The Mental Model

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│   MCP = USB-C for AI                                            │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  LAYER 4: Your Code (Baby Daemon logic)                 │   │
│   │  search(), store(), watch() — your existing functions    │   │
│   ├─────────────────────────────────────────────────────────┤   │
│   │  LAYER 3: MCP Primitives (Tools, Resources, Prompts)    │   │
│   │  registerTool("memory_search", ...) — wraps your funcs  │   │
│   ├─────────────────────────────────────────────────────────┤   │
│   │  LAYER 2: JSON-RPC 2.0 (Wire Format)                   │   │
│   │  {"jsonrpc":"2.0","id":1,"method":"tools/call",...}     │   │
│   ├─────────────────────────────────────────────────────────┤   │
│   │  LAYER 1: Transport (stdio pipes OR HTTP)               │   │
│   │  Raw bytes flowing through stdin/stdout or TCP          │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   Think of it like the OSI model for AI:                        │
│   Transport → Wire Format → Protocol Semantics → Your Logic    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Key Takeaways:

1. **MCP is a protocol**, not a library or framework. It's a set of rules for how AI apps talk to external tools
2. **JSON-RPC 2.0** is the message format (request/response/notification with `id` matching)
3. **stdio transport** = OS pipes between parent and child process (fast, local, no network)
4. **Tools** are the main primitive — functions the AI can call with typed inputs
5. **Lifecycle** = init handshake → capability negotiation → operation → shutdown
6. **Your Baby Daemon already has all the logic**. Phase 5 is literally just wrapping it in MCP tool registrations
7. **One server, every AI host**. That's the whole point — build once, use everywhere

---

> [!TIP]
> Ready for Phase 5? The actual implementation is surprisingly simple — you've already built the hard parts (watcher, summarizer, vector store). MCP is just the "plug" that lets any AI tool use your daemon.
