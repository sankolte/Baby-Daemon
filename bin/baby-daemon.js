#!/usr/bin/env node

/**
 * bin/baby-daemon.js
 * ──────────────────
 * The main entry command for Baby Daemon.
 * 
 * When a user installs globally (npm install -g baby-daemon),
 * they can run: baby-daemon
 * 
 * This shows:
 *   - Quick status (is API key set? are there memories?)
 *   - Available commands
 *   - MCP setup instructions
 *   - First-time setup help
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { resyncAllMemories } from '../src/vectorStore.js';

// Load .env from current working directory (where the user runs the command)
dotenv.config({ path: path.join(process.cwd(), '.env') });

// Also try loading from the package directory (for global installs)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(__dirname, '..');
dotenv.config({ path: path.join(PACKAGE_ROOT, '.env') });

// CLI Styling
const R = '\x1b[0m';     // Reset
const B = '\x1b[1m';     // Bold
const D = '\x1b[2m';     // Dim
const C = '\x1b[36m';    // Cyan
const G = '\x1b[32m';    // Green
const Y = '\x1b[33m';    // Yellow
const M = '\x1b[35m';    // Magenta
const RED = '\x1b[31m';  // Red

const args = process.argv.slice(2);
const command = args[0]?.toLowerCase();

if (command === 'setup') {
  handleSetup();
} else if (command === 'mcp-config') {
  handleMcpConfig();
} else if (command === 'resync') {
  await handleResync();
} else {
  handleDefault();
}

// ─────────────────────────────────────────────────────────────────
// DEFAULT: Show status + available commands
// ─────────────────────────────────────────────────────────────────

function handleDefault() {
  const hasApiKey = !!process.env.GEMINI_API_KEY;
  const memoryFile = path.join(process.cwd(), 'memory.jsonl');
  const hasMemories = fs.existsSync(memoryFile);
  let memoryCount = 0;
  if (hasMemories) {
    try {
      const content = fs.readFileSync(memoryFile, 'utf-8');
      memoryCount = content.split('\n').filter(l => l.trim()).length;
    } catch { /* ignore */ }
  }

  console.log(`
  ${B}${C}🧠 Baby Daemon${R} ${D}v0.1.0${R}
  ${D}AI memory system for coding agents${R}

  ${B}STATUS:${R}
    API Key    : ${hasApiKey ? `${G}✓ Set${R}` : `${RED}✗ Not set${R} ${D}(run: baby-daemon setup)${R}`}
    Memories   : ${hasMemories ? `${G}${memoryCount} stored${R}` : `${Y}None yet${R}`}
    Directory  : ${D}${process.cwd()}${R}

  ${B}COMMANDS:${R}
    ${C}memory-watch ${D}<folder>${R}        Watch a folder for AI chat logs
    ${C}memory search ${D}<query>${R}        Search stored memories (semantic + keyword)
    ${C}memory read${R}                  View all active memories by category
    ${C}memory dump${R}                  Dump raw memory data
    ${C}memory archive${R}               Archive old memories

  ${B}SETUP:${R}
    ${C}baby-daemon setup${R}            First-time setup guide
    ${C}baby-daemon mcp-config${R}       Show MCP server config for Claude/Cursor
    ${C}baby-daemon resync${R}           Sync missing memories into LanceDB vector store

  ${B}MCP SERVER:${R}
    ${D}For AI hosts (Claude Desktop, Cursor, Cline):${R}
    ${C}baby-daemon mcp-config${R}       ${D}← shows the JSON config to copy${R}
  `);
}

// ─────────────────────────────────────────────────────────────────
// SETUP: First-time setup guide
// ─────────────────────────────────────────────────────────────────

function handleSetup() {
  const hasApiKey = !!process.env.GEMINI_API_KEY;
  const envExists = fs.existsSync(path.join(process.cwd(), '.env'));

  console.log(`
  ${B}${C}🧠 Baby Daemon — Setup Guide${R}

  ${B}Step 1: Get a Gemini API Key (free)${R}
  ${D}Go to:${R} ${C}https://aistudio.google.com/apikey${R}
  ${D}Click "Create API key" → copy it${R}

  ${B}Step 2: Create a .env file${R}
  ${D}In your project root, create a file called${R} ${C}.env${R} ${D}with:${R}

    ${G}GEMINI_API_KEY=your_api_key_here${R}

  ${envExists ? `  ${G}✓ .env file found in current directory${R}` : `  ${Y}⚠ No .env file found in ${process.cwd()}${R}`}
  ${hasApiKey ? `  ${G}✓ API key is loaded${R}` : `  ${RED}✗ API key not detected yet${R}`}

  ${B}Step 3: Create a logs folder${R}
  ${D}This is where your AI agent chat logs go:${R}

    ${C}mkdir logs${R}

  ${B}Step 4: Start watching${R}

    ${C}memory-watch ./logs${R}

  ${D}Baby Daemon will now watch for new/changed files in ./logs,
  extract structured memories via Gemini, and store them for search.${R}

  ${B}Step 5 (Optional): Connect to Claude Desktop / Cursor${R}

    ${C}baby-daemon mcp-config${R}
  `);
}

// ─────────────────────────────────────────────────────────────────
// MCP-CONFIG: Show copy-paste MCP configuration
// ─────────────────────────────────────────────────────────────────

function handleMcpConfig() {
  // Find the mcp-server.js path
  const mcpServerPath = path.join(PACKAGE_ROOT, 'mcp-server.js');
  const mcpServerExists = fs.existsSync(mcpServerPath);

  // Format path for JSON (escape backslashes for Windows)
  const escapedPath = mcpServerPath.replace(/\\/g, '\\\\');

  console.log(`
  ${B}${C}🧠 Baby Daemon — MCP Server Configuration${R}

  ${mcpServerExists ? `${G}✓ MCP server found at:${R}` : `${RED}✗ MCP server not found at:${R}`}
  ${D}${mcpServerPath}${R}

  ─────────────────────────────────────────────────────

  ${B}${M}Claude Desktop${R}
  ${D}Add this to:${R} ${C}%APPDATA%\\Claude\\claude_desktop_config.json${R}
  ${D}(Mac: ~/Library/Application Support/Claude/claude_desktop_config.json)${R}

  ${G}{
    "mcpServers": {
      "baby-daemon": {
        "command": "node",
        "args": ["${escapedPath}"]
      }
    }
  }${R}

  ${D}Then restart Claude Desktop.${R}

  ─────────────────────────────────────────────────────

  ${B}${M}Cursor${R}
  ${D}Go to: Settings → MCP → Add Server${R}
  ${D}Command:${R} ${C}node${R}
  ${D}Args:${R}    ${C}${mcpServerPath}${R}

  ─────────────────────────────────────────────────────

  ${B}AVAILABLE TOOLS (auto-discovered by AI host):${R}
    ${C}memory_search${R}    ${D}— Semantic search across all stored memories${R}
    ${C}memory_store${R}     ${D}— Push text through summarization pipeline${R}
    ${C}memory_read${R}      ${D}— Full project knowledge briefing${R}
    ${C}memory_dump${R}      ${D}— Raw memory dump with filters${R}
    ${C}memory_archive${R}   ${D}— Archive old memories${R}

  ${B}RESOURCE:${R}  ${C}memory://status${R}   ${D}— System health dashboard${R}
  ${B}PROMPT:${R}    ${C}continue_from_memory${R} ${D}— Context-rich session bootstrap${R}
  `);
}

// ─────────────────────────────────────────────────────────────────
// RESYNC: Sync missing memories from memory.jsonl → LanceDB
// ─────────────────────────────────────────────────────────────────

async function handleResync() {
  console.log(`
  ${B}${C}🔄 Baby Daemon — Resync${R}
  ${D}Syncing missing memories from memory.jsonl → LanceDB vector store...${R}
`);

  try {
    const result = await resyncAllMemories();
    if (result.synced === 0) {
      console.log(`  ${G}✓ ${result.msg}${R}`);
      console.log(`  ${D}Total memories: ${result.total}${R}\n`);
    } else {
      console.log(`  ${G}✓ ${result.msg}${R}`);
      console.log(`  ${D}Synced : ${result.synced} new memories${R}`);
      console.log(`  ${D}Skipped: ${result.skipped} already in LanceDB${R}`);
      console.log(`  ${D}Total  : ${result.total} memories in memory.jsonl${R}\n`);
    }
  } catch (error) {
    console.error(`  ${RED}✗ Resync failed:${R}`, error.message);
  }
}
