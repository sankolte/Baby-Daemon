# Baby Daemon Internal Project Guide


This guide explains Baby Daemon in simple internal language: what problem it solves, how the system works, how memory is stored, how search/RAG works, what commands exist, and how the design handles the scary problems like duplicate memory, fake AI summaries, stale memory, and failed handoffs between agents.

A background daemon that gives AI coding agents persistent memory across sessions.

## 1. What Problem Are We Solving?

AI coding agents forget context very easily.

Suppose you are building a project with one AI agent today. You discuss bugs, architecture, file changes, future ideas, and important decisions. Tomorrow you open another agent or a new session. That new agent does not automatically know:

- which bugs were already found
- which bugs were fixed
- which ideas were only discussed but not confirmed
- which architecture decisions were final
- which files were changed
- what the current project direction is
- why a previous agent made a certain choice

So the user has to explain everything again. This wastes time and also creates risk, because the next agent may misunderstand the project history.

Baby Daemon solves this by giving AI coding agents a shared memory system.

The simple idea:

```text
Agent conversations happen
  -> Baby Daemon watches those conversation logs
  -> important things are extracted
  -> memories are stored properly
  -> later any agent/user can search those memories
```

The most important principle:

> Raw chat logs are the real source of truth. Stored memories are helpful searchable notes, not absolute truth.

This matters because AI summaries can sometimes be wrong. Baby Daemon keeps the original evidence text with each memory so that future agents can verify where the memory came from.

## 2. What Baby Daemon Does

Baby Daemon is a local memory system for AI coding work.

It does five main things:

1. Watches a folder where AI chat logs are saved.
2. Detects when a new log file is added or an old one changes.
3. Uses an LLM to extract useful project memories from that log.
4. Stores those memories in a structured format.
5. Lets users or AI agents search those memories later using natural language.

Example:

```text
User asks later:
"What was the auth issue yesterday?"

Baby Daemon can return:
"The auth middleware had an expired JWT handling issue.
Evidence: the previous log said JWT verification was throwing an unhandled rejection."
```

So instead of reading every old conversation manually, the user gets the relevant memory quickly.

## 3. High-Level Workflow

This is the main system flow in simple words:

```text
Raw agent chat logs
  -> Baby Daemon watches the folder
  -> duplicate file events are skipped
  -> LLM extracts useful memories
  -> user can optionally approve/reject memories
  -> memories are saved in memory.jsonl
  -> memories are also stored in vector/search form
  -> user or agent searches later
```

What gets stored?

- decisions
- proposed ideas
- rejected ideas
- open questions
- bugs
- resolved bugs
- architecture notes
- file changes

What does not matter much?

- greetings
- repeated small debugging loops
- random small talk
- unimportant formatting changes

## 4. Storage Layers

Baby Daemon stores different kinds of data in different places.

| Storage | What It Means | Why It Exists |
|---|---|---|
| `logs/` | Raw AI conversations | This is the original truth. If summaries look wrong, check logs. |
| `memory.jsonl` | Structured memory notes | This is the main readable memory store. |
| `.lancedb/` | Vector search database | This makes natural language search possible. |
| `.embeddings_cache.json` | Saved embeddings | This avoids paying/recomputing embeddings again and again. |
| `processed_keys.json` | Already-processed file versions | This prevents the same log save from being processed repeatedly. |

The big design point:

```text
logs/ = original truth
memory.jsonl = organized notes
.lancedb/ = fast semantic search index
```

## 5. Commands and What They Are Used For

This section only explains command names and their use, so readers do not get confused by file names or implementation details.

| Command | Use |
|---|---|
| `npm install` | Installs project dependencies. Run once after cloning the project. |
| `npm link` | Makes local CLI commands available globally during development. |
| `baby-daemon` | Shows current Baby Daemon status, such as setup state and memory count. |
| `baby-daemon setup` | Shows first-time setup instructions. |
| `baby-daemon mcp-config` | Prints the config needed to connect Baby Daemon to MCP-compatible AI apps. |
| `baby-daemon resync` | Rebuilds missing vector-search data from existing stored memories. |
| `memory-watch ./logs` | Starts watching the logs folder and automatically stores memories. |
| `memory-watch ./logs --require-approval` | Starts watcher in approval mode, so the user can approve/reject each memory before saving. |
| `memory-watch ./logs -a` | Short version of approval mode. |
| `memory search "query"` | Searches stored memories using natural language. |
| `memory "query"` | Short version of memory search. |
| `memory read` | Shows all active memories grouped by type. Useful when starting a new agent session. |
| `memory dump` | Prints raw logs directly. Use this when search fails or when you want the original context. |
| `memory archive` | Archives old vector memories so active search stays cleaner. |
| `npm run mcp` | Starts the MCP server. Used by MCP-compatible AI hosts. |

Common examples:

```bash
memory-watch ./logs
memory-watch ./logs --require-approval
memory search "auth bug yesterday"
memory search "redis decision" --type decision
memory search "database issue" --since "3 days ago"
memory read
memory dump --since "yesterday"
baby-daemon resync
baby-daemon mcp-config
```

## 6. Ingestion Workflow: How Data Enters the System

Start the watcher:

```bash
memory-watch ./logs
```

Then this happens:

1. Your AI agent writes a chat log into `logs/`.
2. Baby Daemon notices that the file changed.
3. It checks whether this exact file version was already processed.
4. If yes, it skips it.
5. If no, it reads the chat log.
6. The LLM extracts only useful project memory.
7. Memories are saved in a structured way.
8. Those memories are added to search.
9. Later, you can search them using `memory search`.

Simple example:

```text
Raw chat:
"Maybe Redis use karna chahiye for cache, but not final yet."

Good stored memory:
type: proposed_idea
content: Redis was discussed as a possible caching option, but it was not finalized.

Bad stored memory:
type: decision
content: Project migrated to Redis.
```

Baby Daemon is designed to prefer the first one, because it tracks whether something is confirmed or only proposed.

## 7. Idempotency Key: Why We Need It

Sometimes file watchers fire more than once for the same save.

Example:

```text
You save chat_001.md once.
Windows/editor may trigger 2-3 file change events.
Without protection, Baby Daemon may summarize the same file again and again.
That would create duplicate memories.
```

The solution is an idempotency key.

In simple words, an idempotency key is a fingerprint for one exact version of a file.

It answers:

> "Have we already processed this exact file at this exact save time?"

If yes, Baby Daemon skips it.

If no, Baby Daemon processes it and then remembers that fingerprint.

Why this design is useful:

- prevents duplicate memories
- avoids repeated LLM calls
- avoids wasting API cost
- keeps `memory.jsonl` clean
- makes the watcher safe even if the OS fires multiple events

This is a small feature, but it solves a very real reliability problem.

## 8. Manual Approval Mode

Sometimes the user may not want every extracted memory to be stored.

Example:

- the conversation contains private notes
- the LLM extracted something too aggressively
- the user mentioned an idea casually but does not want future agents to treat it seriously
- the extracted memory is technically correct but not useful

For that, Baby Daemon has approval mode:

```bash
memory-watch ./logs --require-approval
```

In this mode, Baby Daemon shows each candidate memory and asks the user:

```text
Approve this memory? (Y/n)
```

If the user says yes, it is stored.

If the user says no, it is skipped.

This is important because the user stays in control. Only the memories the user actually wants are saved. It also helps prevent memory drift, where a casual line like "maybe use Redis" accidentally becomes a future "confirmed Redis decision."

In short:

> Approval mode makes memory storage user-controlled, so only useful and trusted context gets saved.

## 9. How Memory Is Stored Properly

Baby Daemon does not store memories as random text paragraphs.

It stores each memory in a structured format, so future agents can understand what kind of memory it is.

Example memory:

```json
{
  "type": "bug",
  "content": "JWT verification failed when the token was expired.",
  "original_text": "JWT token verification was throwing an unhandled rejection when expired.",
  "confidence": 1,
  "status": "active",
  "related_files": ["auth middleware"],
  "tags": ["auth", "jwt", "bug"]
}
```

What each field means:

| Field | Simple Meaning |
|---|---|
| `type` | What kind of memory this is: bug, decision, idea, etc. |
| `content` | Clean summary of the important point. |
| `original_text` | Evidence from the original chat. This helps verify the summary. |
| `confidence` | How sure the system is. |
| `status` | Whether memory is active, outdated, rejected, etc. |
| `related_files` | Files or areas connected to this memory. |
| `tags` | Search keywords. |

Supported memory types:

| Type | Meaning |
|---|---|
| `decision` | Something confirmed and agreed. |
| `proposed_idea` | Something discussed but not final. |
| `rejected_idea` | Something discussed and rejected. |
| `open_question` | Something still unresolved. |
| `bug` | A problem found. |
| `resolved_bug` | A problem fixed. |
| `architecture_note` | Important design/system information. |
| `file_change` | Important file-level change. |

Why this is powerful:

- "Maybe Redis" can be stored as `proposed_idea`, not `decision`.
- A real bug can be stored as `bug`.
- A fixed bug can be stored as `resolved_bug`.
- Future agents can filter and reason better.

This is how the system avoids mixing everything into one vague summary.

## 10. RAG / Retrieval Workflow

RAG means Retrieval-Augmented Generation.

In simple words:

> Before answering, the system retrieves relevant past memories and gives them as context.

Baby Daemon's RAG works like this:

```text
User asks a question
  -> Baby Daemon searches stored memories
  -> relevant memories are returned
  -> user/agent can continue with context
```

Example:

```bash
memory search "why did login fail?"
```

Even if the stored memory says:

```text
JWT verification failed when expired token caused an unhandled rejection.
```

Baby Daemon can still find it, because vector search understands meaning, not only exact words.

So:

- user says "login fail"
- stored memory says "JWT expired token issue"
- system understands they may be related

That is the useful part of vector search.

## 11. Search Flow in Simple Words

When you run:

```bash
memory search "auth bug yesterday"
```

Baby Daemon does this:

1. Understands the meaning of your query.
2. Searches the vector database for memories with similar meaning.
3. Applies filters if you gave any, like date/type/file.
4. Returns the best memories with evidence text.
5. If vector search fails, it falls back to keyword search.
6. If search still feels wrong, you can dump raw logs directly.

Useful filters:

```bash
memory search "auth issue" --type bug
memory search "database change" --since "yesterday"
memory search "redis" --type proposed_idea
memory search "middleware" --file auth
```

Why this is better than reading all logs:

- you ask in natural language
- you get only relevant memories
- you can filter by time/type/file
- you still get evidence from original chat

## 12. Raw Dump Fallback

Search systems can fail.

Vector DB can break. Embeddings can fail. Search may return weak results. The query may be too vague.

So Baby Daemon has an escape hatch:

```bash
memory dump --since "yesterday"
```

This prints raw logs directly.

This is important because even if the smart memory layer breaks, the original conversation history is still accessible.

Example:

```text
If memory search cannot find "auth bug",
use memory dump --since "yesterday"
and inspect the real chat logs.
```

This protects the project from complete memory failure.

## 13. MCP Integration

MCP means Model Context Protocol.

Simple meaning:

> MCP lets AI apps call Baby Daemon directly as a tool.

Without MCP, every AI app would need a custom integration.

With MCP, Baby Daemon exposes tools once, and MCP-compatible apps can use them.

Examples of MCP-compatible hosts:

- Claude Desktop
- Cursor
- Cline
- Windsurf

Baby Daemon exposes these MCP tools:

| MCP Tool | Use |
|---|---|
| `memory_search` | Search stored memories. |
| `memory_store` | Store important text as memory. |
| `memory_dump` | Read stored/raw memory data without smart ranking. |
| `memory_archive` | Archive old memories. |
| `memory_read` | Read all active project memories grouped by type. |

There is also a prompt:

| Prompt | Use |
|---|---|
| `continue_from_memory` | Helps a new agent start with relevant previous context. |

Important point:

MCP mode does not replace `memory-watch`. The watcher is still the background process that watches logs. MCP is another way for AI apps to search/read/store memory.

## 14. Problems and How Baby Daemon Solves Them

### Problem 1: AI Agents Forget Everything

Problem:

Every new AI session starts almost fresh. If yesterday you fixed an auth bug, today's agent may not know that.

Example:

```text
Yesterday:
"The JWT expiry bug was fixed by catching token errors and returning 401."

Today:
New agent asks: "What auth bug?"
```

Solution:

Baby Daemon stores important session memories, so the new agent can search:

```bash
memory search "auth bug"
```

Now the old context can be retrieved instead of re-explained manually.

### Problem 2: Watcher Fires Multiple Times

Problem:

One file save can trigger multiple file events. Without protection, the same log could be summarized multiple times.

Example:

```text
You save chat_004.md once.
The OS sends 3 change events.
Without duplicate protection, memory gets saved 3 times.
```

Solution:

Baby Daemon creates a fingerprint for each exact file version. If it has already processed that file version, it skips it.

This keeps memory clean and avoids repeated LLM calls.

### Problem 3: Same Chat File Keeps Growing

Problem:

Many AI chat logs are not final immediately. The file grows as the conversation continues.

Example:

```text
At 10:00, chat_001.md has 20 lines.
At 10:30, same file has 80 lines.
```

If Baby Daemon just kept appending summaries, old memories from line 1-20 could be duplicated.

Solution:

When the same chat file is processed again, Baby Daemon replaces old memories from that file with the fresh version. This means the memory stays updated instead of duplicated.

### Problem 4: LLM Converts "Maybe" Into "Decision"

Problem:

LLMs often compress uncertainty.

Dangerous example:

```text
Original chat:
"Maybe Redis use karna chahiye."

Bad memory:
"Project migrated to Redis."
```

This is dangerous because a future agent may believe Redis is already confirmed and start writing Redis code.

Solution:

Baby Daemon stores memory by type:

- `proposed_idea` for maybe/discussed ideas
- `decision` only for confirmed decisions
- `open_question` for unresolved things
- `rejected_idea` for discarded ideas

It also stores the original evidence text. So if a memory looks suspicious, the user or agent can check what was actually said.

Extra safety:

```bash
memory-watch ./logs --require-approval
```

This lets the user approve or reject every candidate memory before it is saved.

### Problem 5: User Does Not Want Some Data Stored

Problem:

Sometimes the system may extract something technically valid, but the user does not want it saved.

Example:

```text
"Try this quick hack only for testing."
```

The user may not want future agents to remember this as a real project direction.

Solution:

Approval mode lets the user say no before the memory is stored.

So only the useful and wanted memories become long-term memory.

### Problem 6: Search Retrieves Wrong Context

Problem:

Semantic search is powerful, but it can sometimes return related-looking but wrong context.

Example:

```text
Query:
"payment timeout"

Wrong result:
"auth token timeout"
```

Both contain timeout, but they are different problems.

Solution:

Baby Daemon uses multiple safety layers:

- semantic search for meaning
- keyword fallback when semantic search is weak
- filters like `--type`, `--since`, and `--file`
- evidence text so results can be checked

Example:

```bash
memory search "payment timeout" --type bug --since "last week"
```

This narrows the search and reduces wrong matches.

### Problem 7: Vector Search or LanceDB Breaks

Problem:

Vector DBs can fail. Native dependencies can have issues. Embeddings can fail.

If the whole memory system depended only on vector search, one failure could make memory unusable.

Solution:

Baby Daemon has fallback paths:

1. Try vector search.
2. If that fails, use keyword search.
3. If that is not enough, dump raw logs.

Example:

```bash
memory dump --since "yesterday"
```

This means the system never fully loses access to project history.

### Problem 8: Old Memories Become Stale

Problem:

Projects change.

Example:

```text
Month 1:
"Use REST API."

Month 4:
"Project moved to GraphQL."
```

If old memories stay active forever, future agents may read outdated context.

Solution:

Baby Daemon stores timestamps and supports archiving old memories.

Command:

```bash
memory archive --age 30
```

This helps keep active memory cleaner.

Current limitation:

Automatic contradiction detection is not fully implemented yet. So archiving exists, but automatic "this old memory is now wrong" logic is still future work.

### Problem 9: Different AI Models Understand Memory Differently

Problem:

Claude, Gemini, GPT, Cursor agents, and other models may interpret the same summary differently.

Example:

```text
Memory:
"Redis was discussed for caching."

One model may treat it as an idea.
Another may accidentally treat it as a direction.
```

Solution:

Baby Daemon keeps memory simple and structured:

- type
- content
- evidence
- confidence
- tags

It also tells future agents to treat memories as helpful hints, not unquestionable facts.

The agent should still verify against the actual codebase.

### Problem 10: Handoff Drift Across Many Agents

Problem:

If Agent A summarizes, then Agent B summarizes that summary, then Agent C summarizes that summary again, details get lost.

Example:

```text
Original:
"JWT failed because expired tokens threw unhandled rejection in auth middleware."

After repeated summaries:
"Auth issue happened."
```

Important details disappeared.

Solution:

Baby Daemon does not summarize old summaries as the source of truth. It keeps raw logs as ground truth and uses memories as searchable notes.

This is a strong design choice because it prevents summaries from becoming fake reality.

## 15. Memory Correctness Philosophy

Baby Daemon is not trying to make AI memory magically perfect.

Instead, it makes memory safer.

The system assumes:

```text
Raw logs = truth
Memory entries = useful notes
Search index = fast lookup
AI answer = must still be verified when important
```

This is the correct mindset:

> Memory is a hint, not a law.

Baby Daemon reduces risk using:

- structured memory types
- evidence text
- confidence scores
- user approval mode
- duplicate prevention
- raw log fallback
- MCP prompt warning to verify memory

That combination makes the system practically useful without pretending AI summaries are always perfect.

## 16. Recommended Daily Workflow

Start watching logs:

```bash
memory-watch ./logs
```

If you want control over what gets saved:

```bash
memory-watch ./logs --require-approval
```

Search past context:

```bash
memory search "what was the auth issue yesterday?"
```

Start a new agent session with context:

```bash
memory read
```

If search does not find what you need:

```bash
memory dump --since "yesterday"
```

If vector search data needs rebuilding:

```bash
baby-daemon resync
```

Connect to MCP-compatible AI apps:

```bash
baby-daemon mcp-config
```

## 17. One-Line Explanation

Baby Daemon watches AI chat logs, extracts useful project memories, stores them safely with evidence, and lets any user or AI agent search those memories later instead of losing project context between sessions.
