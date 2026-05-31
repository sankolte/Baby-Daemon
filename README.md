# 🧠 Baby Daemon

> A background daemon that gives AI coding agents persistent memory across sessions.

---

## The Problem

Every AI coding session is stateless by default. Switch agents, restart a session, or continue the next day — your AI forgets everything. Decisions, bugs, architecture choices. You re-explain it all. Every. Single. Time.

**Baby Daemon fixes that.**

---

## How It Works

```
1. Run `memory-watch ./logs`  →  daemon starts watching your agent's chat logs
2. File changes detected      →  Gemini 2.5 Flash extracts structured memories
3. Memories stored            →  LanceDB (vector) + memory.jsonl (flat)
4. New session, new agent     →  `memory search "why did auth break?"` → instant context
```

---

## CLI Commands

```bash
# Start the daemon (watches a folder for AI chat logs)
memory-watch ./logs

# Start with human approval for high-confidence decisions
memory-watch ./logs --require-approval

# Semantic search across all stored memories
memory search "authentication bug"

# Filtered search
memory search "caching strategy" --type decision --since "3 days ago"

# Dump raw logs (bypasses vector DB — emergency fallback)
memory dump --since "yesterday"

# Archive old memories to keep search fast
memory archive --age 14
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ES Modules) |
| File Watcher | `chokidar` (event-driven, OS-native) |
| LLM Summarizer | Google Gemini 2.5 Flash |
| Embeddings | `gemini-embedding-2` |
| Vector DB | LanceDB (local, embedded — no server) |
| Keyword Fallback | `minisearch` (pure JS) |
| Date Parsing | `chrono-node` ("yesterday", "2 days ago") |
| Integrity | SHA-256 hashing (`node:crypto`) |

---

## Memory Schema

Every memory is a structured, typed object — never a plain string:

```json
{
  "id": "mem-1716300000-a1b2c3d4",
  "timestamp": "2026-05-21T10:30:00Z",
  "type": "proposed_idea",
  "content": "Consider switching to Redis for caching layer",
  "original_text": "maybe we should use Redis...",
  "confidence": 0.4,
  "status": "active",
  "related_files": ["cache.ts"],
  "tags": ["redis", "caching"],
  "source": { "chat_file": "chat_042.md" },
  "hash": "e4a91b7a9f..."
}
```

**Types:** `decision` · `proposed_idea` · `rejected_idea` · `open_question` · `bug` · `resolved_bug` · `architecture_note` · `file_change`

---

## Key Design Decisions

### Duplicate Prevention (Idempotency)
OS file watchers fire multiple times per save. Every file event is fingerprinted:
```
key = SHA-256(absolute_path + "|" + last_modified_ms)
```
Key is stored in `processed_keys.json`. Only recorded **after** successful processing — so failures auto-retry.

### Memory Drift Prevention
LLMs compress uncertainty. *"Maybe use Redis"* becomes *"Project migrated to Redis."*

Fixes:
- Strict type schema — `decision` requires explicit commitment from both sides
- Every memory stores the **exact source quote** (`original_text`)
- `--require-approval` flag for human-in-the-loop on high-risk memories
- `status: outdated` for contradicted memories + archival system

### 3-Layer Hybrid Search
1. **LanceDB vector search** — cosine similarity, 0.70 threshold
2. **Metadata filtering** — type, date (natural language via chrono-node), file
3. **MiniSearch keyword fallback** — if vector search returns nothing
4. **Raw dump fallback** — if everything else fails, `memory dump` bypasses the AI layer entirely

### Never Summarize a Summary
Memories are always generated from **original raw logs**, never from previous summaries. Prevents information entropy across multi-agent handoffs.

---

## Build Phases

- [x] **Phase 1** — File watcher shell + idempotency
- [x] **Phase 2** — Gemini summarization pipeline + structured schema
- [x] **Phase 3** — LanceDB vector store + semantic search
- [x] **Phase 4** — Integrity (SHA-256 hashes, fallback dump, approval mode, archival)
- [x] **Phase 5** — MCP Server (wrap as plug-and-play tool for any MCP-compatible agent)

---

## Setup

```bash
git clone https://github.com/sankolte/Baby-Daemon.git
cd Baby-Daemon
npm install
cp .env.example .env
# Add your GEMINI_API_KEY to .env
```

```bash
# Watch your logs folder
node bin/memory-watch.js ./logs

# Or if installed globally via npm link:
memory-watch ./logs
```

---

## Project Structure

```
├── mcp-server.js           ← MCP server entry point (Phase 5)
├── bin/
│   ├── memory-watch.js     ← Start the daemon
│   └── memory.js           ← Search, dump, archive
├── src/
│   ├── watcher.js          ← chokidar + pipeline orchestration
│   ├── summarizer.js       ← Gemini call + JSON schema enforcement
│   ├── vectorStore.js      ← LanceDB, embeddings cache, MiniSearch fallback
│   ├── memoryStore.js      ← JSONL read/write
│   ├── idempotency.js      ← SHA-256 key generation + persistence
│   └── config.js           ← Gemini SDK init
├── memory.jsonl            ← Flat structured memory store (gitignored)
├── .lancedb/               ← Local vector DB (gitignored)
├── claude_desktop_config.example.json  ← Example MCP config
└── .env.example            ← Environment variable template
```

---

## Phase 5 — MCP Server

Baby Daemon is now available as an **MCP (Model Context Protocol) server**. Any MCP-compatible AI host can use it natively — no CLI required.

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Semantic + keyword search with filters (type, date, file, limit) |
| `memory_store` | Push raw text through the summarization pipeline and store |
| `memory_dump` | Dump all stored memories with optional filters |
| `memory_archive` | Move old memories to archive table |
| `memory_read` | Full project knowledge briefing grouped by category |

**Resource:** `memory://status` — system health, counts, LanceDB status  
**Prompt:** `continue_from_memory` — context-rich prompt to resume work from previous sessions

### Setup for Claude Desktop

Add to `%APPDATA%/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "baby-daemon": {
      "command": "node",
      "args": ["C:\\path\\to\\proj101\\mcp-server.js"]
    }
  }
}
```

Restart Claude Desktop — Baby Daemon tools appear automatically.

### Setup for Cursor / Cline / Other MCP Hosts

Most MCP hosts use a similar JSON config. Point it to:
```
command: node
args: ["<absolute-path-to>/mcp-server.js"]
```

### Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector node mcp-server.js
```

Opens a web UI where you can interactively test all tools, read resources, and invoke prompts.

---

## License

MIT
