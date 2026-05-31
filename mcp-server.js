#!/usr/bin/env node

/**
 * mcp-server.js
 * ─────────────
 * Phase 5 — Baby Daemon MCP Server
 *
 * WHAT THIS FILE DOES:
 *   Wraps all existing Baby Daemon functionality (search, store, dump, archive)
 *   as an MCP (Model Context Protocol) server. Any MCP-compatible AI host
 *   (Claude Desktop, Cursor, Cline, Windsurf, etc.) can spawn this as a child
 *   process and use Baby Daemon's memory tools natively.
 *
 * HOW IT WORKS:
 *   1. The AI host (e.g. Claude Desktop) spawns: node mcp-server.js
 *   2. Host and server do a JSON-RPC handshake over stdin/stdout
 *   3. Host discovers available tools via tools/list
 *   4. LLM calls tools like memory_search when the user asks about past context
 *   5. Server executes using existing Baby Daemon modules and returns results
 *
 * CONCEPT: stdio transport
 *   No HTTP, no ports, no network. The host writes JSON-RPC messages to our
 *   stdin pipe, we read them, execute, and write responses to stdout.
 *   stderr is reserved for debug logs (never send JSON-RPC on stderr).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Import existing Baby Daemon modules ─────────────────────────
import { searchMemories, archiveMemories } from './src/vectorStore.js';
import { readAllMemories } from './src/memoryStore.js';
import { summarizeChatLog } from './src/summarizer.js';
import { saveMemoriesForFile } from './src/memoryStore.js';
import { syncMemoriesToVectorStore } from './src/vectorStore.js';

// ── Paths ───────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.join(__dirname, 'memory.jsonl');
const LOGS_DIR = path.join(__dirname, 'logs');

// ─────────────────────────────────────────────────────────────────
// 1. CREATE THE MCP SERVER
// ─────────────────────────────────────────────────────────────────

/**
 * CONCEPT: McpServer
 *   The SDK provides a high-level McpServer class that handles:
 *   - JSON-RPC 2.0 message parsing and framing
 *   - The initialization handshake (capability negotiation)
 *   - Tool/resource/prompt registration and dispatch
 *   - Error formatting
 *
 *   We just register our tools and connect — the SDK does the rest.
 */
const server = new McpServer({
  name: 'baby-daemon',
  version: '1.0.0',
  description: 'AI memory system — stores, searches, and retrieves project context across coding sessions and agents.',
});

// ─────────────────────────────────────────────────────────────────
// 2. REGISTER TOOLS
// ─────────────────────────────────────────────────────────────────

/**
 * CONCEPT: Tool registration
 *   server.tool(name, description, inputSchema, handler)
 *
 *   - name: What the LLM sees and calls (e.g. "memory_search")
 *   - description: CRITICAL — the LLM reads this to decide WHEN to use the tool.
 *     A bad description = the AI never calls your tool or calls it wrong.
 *   - inputSchema: Zod schema that validates inputs. The SDK converts this to
 *     JSON Schema for the LLM to understand the expected arguments.
 *   - handler: Your function. Receives validated args, returns { content: [...] }
 *
 *   The return format is always:
 *   { content: [{ type: "text", text: "..." }] }
 *   This is part of the MCP spec — all tool results are arrays of content blocks.
 */

// ── TOOL 1: memory_search ────────────────────────────────────────

server.tool(
  'memory_search',
  'Search through project memories using semantic vector similarity and keyword fallback. ' +
  'Use this when the user asks about past decisions, bugs, fixes, architecture choices, or any historical project context. ' +
  'Supports natural language queries like "What was the auth bug yesterday?" or "How did we fix the payment timeout?". ' +
  'Returns ranked results with confidence scores, source references, and evidence quotes.',
  {
    query: z.string().describe('Natural language search query (e.g. "authentication issue", "database migration decision")'),
    type: z.string().optional().describe('Filter by memory type: decision, proposed_idea, rejected_idea, open_question, bug, resolved_bug, architecture_note, file_change'),
    since: z.string().optional().describe('ISO 8601 date string to filter memories created after this date (e.g. "2026-05-29T00:00:00Z")'),
    file: z.string().optional().describe('Filter by related file name or source chat file'),
    limit: z.number().optional().describe('Maximum number of results to return (default: 5)'),
  },
  async ({ query, type, since, file, limit = 5 }) => {
    try {
      const result = await searchMemories(query, { since, type, file, limit });

      if (result.results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No matching memories found. Try a different query, broaden your search, or check if memories have been stored yet.',
          }],
        };
      }

      // Format results for the LLM in a clear, structured way
      const formatted = result.results.map((item, i) => {
        const score = item.score ? ` (similarity: ${(item.score * 100).toFixed(0)}%)` : '';
        const relatedFiles = item.related_files?.length > 0 ? `\n   Related files: ${item.related_files.join(', ')}` : '';
        const evidence = item.original_text ? `\n   Evidence: "${item.original_text}"` : '';
        return `${i + 1}. [${item.type?.toUpperCase()}]${score}\n   ${item.content}${relatedFiles}${evidence}\n   Source: ${item.chat_file} | Date: ${item.timestamp}`;
      });

      return {
        content: [{
          type: 'text',
          text: `Found ${result.results.length} memories (via ${result.method} search):\n\n${formatted.join('\n\n')}`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Search failed: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ── TOOL 2: memory_store ─────────────────────────────────────────

server.tool(
  'memory_store',
  'Process raw text (conversation log, code review, meeting notes, etc.) through the AI summarization pipeline ' +
  'and store the extracted memories. The text is sent to Gemini for structured extraction — it identifies decisions, ' +
  'bugs, architecture notes, proposed ideas, etc. — then saves them to memory.jsonl and syncs with the vector database. ' +
  'Use this when you want to preserve important context from the current session for future agents.',
  {
    content: z.string().describe('The raw text content to process and extract memories from (e.g. a conversation log, code review notes, or any text with technical context)'),
    source_name: z.string().optional().describe('A descriptive name for the source of this content (default: "mcp-session-<timestamp>.md")'),
  },
  async ({ content, source_name }) => {
    try {
      const fileName = source_name || `mcp-session-${Date.now()}.md`;

      // Run through the full summarization pipeline
      const memories = await summarizeChatLog(content, fileName);

      if (memories.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No significant memories were extracted from the provided content. The text may not contain technical decisions, bugs, or architecture-relevant information.',
          }],
        };
      }

      // Save to memory.jsonl
      const savedCount = saveMemoriesForFile(fileName, memories);

      // Sync to vector store (LanceDB)
      await syncMemoriesToVectorStore(fileName, memories);

      // Format summary of what was stored
      const summary = memories.map((mem, i) =>
        `${i + 1}. [${mem.type.toUpperCase()}] (confidence: ${mem.confidence.toFixed(2)}) ${mem.content}`
      );

      return {
        content: [{
          type: 'text',
          text: `Successfully extracted and stored ${memories.length} memories from "${fileName}":\n\n${summary.join('\n')}\n\nMemories are now searchable via memory_search.`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Memory storage failed: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ── TOOL 3: memory_dump ──────────────────────────────────────────

server.tool(
  'memory_dump',
  'Dump all stored memories as raw data, optionally filtered by date. This is a fallback tool — use it when ' +
  'semantic search is not finding what you need, or when you want to see ALL stored memories without ranking. ' +
  'Also useful for debugging or verifying what the memory system has stored.',
  {
    since: z.string().optional().describe('ISO 8601 date string — only return memories created after this date'),
    type: z.string().optional().describe('Filter by memory type: decision, proposed_idea, rejected_idea, open_question, bug, resolved_bug, architecture_note, file_change'),
  },
  async ({ since, type }) => {
    try {
      let memories = readAllMemories();

      // Apply date filter
      if (since) {
        const cutoff = new Date(since);
        if (!isNaN(cutoff.getTime())) {
          memories = memories.filter(m => new Date(m.timestamp) >= cutoff);
        }
      }

      // Apply type filter
      if (type) {
        const targetType = type.trim().toLowerCase();
        memories = memories.filter(m => m.type?.toLowerCase() === targetType);
      }

      if (memories.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No memories found matching the given filters.',
          }],
        };
      }

      // Format as readable output
      const formatted = memories.map((mem, i) => {
        const files = mem.related_files?.length > 0 ? ` | Files: ${mem.related_files.join(', ')}` : '';
        return `${i + 1}. [${mem.type?.toUpperCase()}] ${mem.content}\n   Confidence: ${mem.confidence} | Status: ${mem.status} | Source: ${mem.source?.chat_file}${files}\n   Date: ${mem.timestamp}`;
      });

      return {
        content: [{
          type: 'text',
          text: `Dumping ${memories.length} memories:\n\n${formatted.join('\n\n')}`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Memory dump failed: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ── TOOL 4: memory_archive ───────────────────────────────────────

server.tool(
  'memory_archive',
  'Move old memories from the active table to an archive table in LanceDB. ' +
  'This keeps the active search pool small and fast. Archived memories are still stored but won\'t appear in regular searches. ' +
  'Use this for maintenance when the memory database grows large.',
  {
    age_days: z.number().optional().describe('Archive memories older than this many days (default: 30)'),
  },
  async ({ age_days = 30 }) => {
    try {
      const result = await archiveMemories({ ageDays: age_days });
      return {
        content: [{
          type: 'text',
          text: result.msg,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Archival failed: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ── TOOL 5: memory_read ──────────────────────────────────────────

server.tool(
  'memory_read',
  'Load a complete project knowledge briefing — all active memories grouped by category ' +
  '(decisions, architecture notes, active bugs, resolved bugs, file changes, proposed ideas, open questions). ' +
  'Use this at the start of a new session to get full project context, or when you need a comprehensive overview ' +
  'of everything the memory system knows about the project.',
  {},
  async () => {
    try {
      const allMemories = readAllMemories();
      const activeMemories = allMemories.filter(m => m.status === 'active');

      if (activeMemories.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No active memories found in this project. Memories are created when the file watcher processes chat logs, or when content is stored via the memory_store tool.',
          }],
        };
      }

      // Group by type
      const groups = {};
      activeMemories.forEach(mem => {
        const type = mem.type || 'other';
        if (!groups[type]) groups[type] = [];
        groups[type].push(mem);
      });

      // Format each group
      const displayOrder = [
        { key: 'decision', title: '📢 DECISIONS' },
        { key: 'architecture_note', title: '🏗️ ARCHITECTURE NOTES' },
        { key: 'bug', title: '🐛 ACTIVE BUGS' },
        { key: 'resolved_bug', title: '✅ RESOLVED BUGS' },
        { key: 'file_change', title: '📝 FILE CHANGES' },
        { key: 'proposed_idea', title: '💡 PROPOSED IDEAS' },
        { key: 'open_question', title: '❓ OPEN QUESTIONS' },
      ];

      const sections = [];
      for (const { key, title } of displayOrder) {
        const items = groups[key];
        if (!items || items.length === 0) continue;

        const lines = items.map((item, i) => {
          const files = item.related_files?.length > 0 ? ` (files: ${item.related_files.join(', ')})` : '';
          return `  ${i + 1}. ${item.content}${files}`;
        });

        sections.push(`${title} (${items.length}):\n${lines.join('\n')}`);
        delete groups[key]; // Remove processed group
      }

      // Handle any remaining types not in displayOrder
      for (const [type, items] of Object.entries(groups)) {
        const lines = items.map((item, i) => `  ${i + 1}. ${item.content}`);
        sections.push(`🔮 ${type.toUpperCase()} (${items.length}):\n${lines.join('\n')}`);
      }

      return {
        content: [{
          type: 'text',
          text: `Project Knowledge Briefing (${activeMemories.length} active memories):\n\n${sections.join('\n\n')}`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Read failed: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ─────────────────────────────────────────────────────────────────
// 3. REGISTER RESOURCES
// ─────────────────────────────────────────────────────────────────

/**
 * CONCEPT: Resources
 *   Resources are read-only data the AI can access. Unlike tools (which the LLM
 *   decides to call), resources are typically pulled by the client/user.
 *   Think of them as "files" or "views" the AI can read.
 */

server.resource(
  'memory-status',
  'memory://status',
  async (uri) => {
    try {
      const allMemories = readAllMemories();
      const active = allMemories.filter(m => m.status === 'active');
      const outdated = allMemories.filter(m => m.status === 'outdated');

      // Count by type
      const typeCounts = {};
      active.forEach(m => {
        const t = m.type || 'unknown';
        typeCounts[t] = (typeCounts[t] || 0) + 1;
      });

      // Find latest memory timestamp
      const timestamps = allMemories.map(m => new Date(m.timestamp).getTime()).filter(t => !isNaN(t));
      const lastMemory = timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : 'none';

      // Check if LanceDB is available
      let lanceDbStatus = 'unknown';
      try {
        await import('@lancedb/lancedb');
        lanceDbStatus = 'available';
      } catch {
        lanceDbStatus = 'unavailable (using MiniSearch fallback)';
      }

      const status = {
        total_memories: allMemories.length,
        active_memories: active.length,
        outdated_memories: outdated.length,
        memories_by_type: typeCounts,
        last_memory_timestamp: lastMemory,
        memory_file: MEMORY_FILE,
        memory_file_exists: fs.existsSync(MEMORY_FILE),
        lancedb_status: lanceDbStatus,
        logs_directory: LOGS_DIR,
        logs_directory_exists: fs.existsSync(LOGS_DIR),
      };

      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(status, null, 2),
        }],
      };
    } catch (error) {
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'text/plain',
          text: `Error reading status: ${error.message}`,
        }],
      };
    }
  }
);

// ─────────────────────────────────────────────────────────────────
// 4. REGISTER PROMPTS
// ─────────────────────────────────────────────────────────────────

/**
 * CONCEPT: Prompts
 *   Pre-written prompt templates that help the AI behave in a specific way.
 *   When invoked, the server returns a crafted prompt that includes memory context.
 *   The AI host can use this to "bootstrap" a new session with project knowledge.
 */

server.prompt(
  'continue_from_memory',
  'Load relevant project memories and generate a context-rich prompt to continue coding from where the last agent or session left off. ' +
  'Use this at the start of a new coding session to inherit all previous context.',
  {
    task: z.string().describe('What you want to work on (e.g. "implement payment flow", "fix the auth bug", "refactor database layer")'),
  },
  async ({ task }) => {
    try {
      // Get all active memories for context
      const allMemories = readAllMemories();
      const activeMemories = allMemories.filter(m => m.status === 'active');

      // Also try to find task-specific memories via search
      let relevantMemories = [];
      try {
        const searchResult = await searchMemories(task, { limit: 5 });
        relevantMemories = searchResult.results || [];
      } catch {
        // Search might fail if no memories exist yet — that's OK
      }

      // Build the context sections
      let contextBlock = '';

      if (relevantMemories.length > 0) {
        const relevant = relevantMemories.map((m, i) =>
          `${i + 1}. [${m.type?.toUpperCase()}] ${m.content}`
        ).join('\n');
        contextBlock += `\n\nMost relevant memories for your task:\n${relevant}`;
      }

      if (activeMemories.length > 0) {
        // Group key info
        const decisions = activeMemories.filter(m => m.type === 'decision');
        const bugs = activeMemories.filter(m => m.type === 'bug');
        const architecture = activeMemories.filter(m => m.type === 'architecture_note');

        if (decisions.length > 0) {
          contextBlock += `\n\nKey decisions made:\n${decisions.map(d => `• ${d.content}`).join('\n')}`;
        }
        if (bugs.length > 0) {
          contextBlock += `\n\nActive bugs:\n${bugs.map(b => `• ${b.content}`).join('\n')}`;
        }
        if (architecture.length > 0) {
          contextBlock += `\n\nArchitecture notes:\n${architecture.map(a => `• ${a.content}`).join('\n')}`;
        }
      }

      if (!contextBlock) {
        contextBlock = '\n\nNo previous memories found. This appears to be a fresh project or the memory system hasn\'t ingested any chat logs yet.';
      }

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `You are continuing work on a coding project. Here is the context from previous sessions, automatically retrieved from the Baby Daemon memory system.

IMPORTANT: Treat these memories as helpful hints, NOT absolute truth. They were auto-generated from past conversations. Always verify against the actual codebase before making changes. If a memory seems uncertain or contradictory, ask the user for clarification.
${contextBlock}

Your task: ${task}

Please review the context above, then proceed with the task. Start by confirming your understanding of the current state and any assumptions you're making.`,
            },
          },
        ],
      };
    } catch (error) {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Failed to load project memories: ${error.message}\n\nPlease proceed with the task "${task}" without historical context. Ask the user for any needed background.`,
            },
          },
        ],
      };
    }
  }
);

// ─────────────────────────────────────────────────────────────────
// 5. CONNECT TO STDIO TRANSPORT AND START
// ─────────────────────────────────────────────────────────────────

/**
 * CONCEPT: StdioServerTransport
 *   This connects the MCP server to stdin/stdout pipes.
 *   The host (Claude Desktop, Cursor, etc.) spawns this process and communicates
 *   via those pipes. No HTTP server, no ports, no network — just OS-level IPC.
 *
 *   Under the hood:
 *   - Reads line-delimited JSON-RPC messages from process.stdin
 *   - Writes JSON-RPC responses to process.stdout
 *   - Debug logs go to process.stderr (safe, won't interfere with protocol)
 */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is now running and listening on stdin.
  // It will stay alive as long as the host keeps the pipe open.
  // The SDK handles the full lifecycle: init handshake → operation → shutdown.
  console.error('Baby Daemon MCP server started and listening on stdio.');
}

main().catch((error) => {
  console.error('Fatal: Failed to start MCP server:', error);
  process.exit(1);
});
