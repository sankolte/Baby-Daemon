#!/usr/bin/env node

/**
 * bin/memory.js
 * ─────────────
 * CLI tool to search, dump, and archive memories.
 *
 * Usage:
 *   memory search "authentication issue" --type bug --since "2 days ago"
 *   memory "authentication issue" --type bug
 *   memory dump --since "yesterday"
 *   memory archive --age 15
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import * as chrono from 'chrono-node';
import { searchMemories, archiveMemories } from '../src/vectorStore.js';

// Resolve __dirname equivalent in ES Modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_LOGS_DIR = path.join(PROJECT_ROOT, 'logs');

// CLI Styling Tokens
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';

// Parse CLI args
const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

// ─────────────────────────────────────────────────────────
// ROUTE SUBCOMMAND
// ─────────────────────────────────────────────────────────

const command = args[0].toLowerCase();

if (command === 'dump') {
  await handleDump();
} else if (command === 'archive') {
  await handleArchive();
} else {
  // If first argument is 'search', execute search with subsequent args.
  // Otherwise, treat the entire set of args as search (implicit search).
  await handleSearch();
}

// ─────────────────────────────────────────────────────────
// SEARCH HANDLER
// ─────────────────────────────────────────────────────────
async function handleSearch() {
  let queryStartIndex = 0;
  if (args[0].toLowerCase() === 'search') {
    queryStartIndex = 1;
  }

  // Find the query (everything before the first option flag)
  const queryParts = [];
  let i = queryStartIndex;
  while (i < args.length && !args[i].startsWith('-')) {
    queryParts.push(args[i]);
    i++;
  }

  const queryText = queryParts.join(' ').trim();

  if (!queryText) {
    console.error(`\n  ${RED}✗ Error:${RESET} No search query specified.\n`);
    printHelp();
    process.exit(1);
  }

  // Extract flag values
  const sinceVal = getFlagValue('--since', args);
  const typeVal = getFlagValue('--type', args);
  const fileVal = getFlagValue('--file', args);
  const limitVal = getFlagValue('--limit', args) || '5';

  const limit = parseInt(limitVal, 10);

  // Parse natural language date using chrono-node
  let sinceDate = null;
  if (sinceVal) {
    const parsed = chrono.parseDate(sinceVal);
    if (!parsed) {
      console.warn(`  ${YELLOW}⚠️  Warning:${RESET} Could not parse date description "${sinceVal}". Ignoring date filter.`);
    } else {
      sinceDate = parsed.toISOString();
    }
  }

  console.log(`\n  ${CYAN}🔍 Querying memories...${RESET}`);
  if (sinceVal && sinceDate) console.log(`  ${DIM}• Since: ${sinceVal} (${new Date(sinceDate).toLocaleDateString()})${RESET}`);
  if (typeVal) console.log(`  ${DIM}• Type: ${typeVal}${RESET}`);
  if (fileVal) console.log(`  ${DIM}• File: ${fileVal}${RESET}`);

  try {
    const searchResult = await searchMemories(queryText, {
      since: sinceDate,
      type: typeVal,
      file: fileVal,
      limit,
    });

    const { method, results } = searchResult;

    if (results.length === 0) {
      console.log(`\n  ${YELLOW}No matching memories found.${RESET}\n`);
      return;
    }

    const headerIcon = method === 'semantic' ? '🧠' : '🔍';
    const methodNameText = method === 'semantic' ? 'Semantic Vector Search' : 'Keyword Fallback Search';

    console.log(`\n  ${headerIcon} ${BOLD}${CYAN}[${methodNameText}]${RESET} Found ${results.length} matches:`);

    results.forEach((item, index) => {
      const displayScore = item.score ? ` (similarity: ${(item.score * 100).toFixed(0)}%)` : '';
      const formattedDate = new Date(item.timestamp).toLocaleString();
      const relativeSource = item.chat_file;

      console.log(`\n  ${CYAN}${BOLD}${index + 1}. [${item.type.toUpperCase()}]${RESET}${displayScore}`);
      console.log(`  ${DIM}Date: ${formattedDate} | Source: ${relativeSource}${RESET}`);
      console.log(`  ${BOLD}Content:${RESET} ${item.content}`);
      if (item.related_files && item.related_files.length > 0) {
        console.log(`  ${DIM}Related files:${RESET} ${item.related_files.join(', ')}`);
      }
      if (item.original_text) {
        console.log(`  ${DIM}Evidence:${RESET}`);
        const formattedContext = item.original_text
          .split('\n')
          .map(line => `    | ${line}`)
          .join('\n');
        console.log(`${DIM}${formattedContext}${RESET}`);
      }
      console.log(`  ${DIM}─────────────────────────────────────────${RESET}`);
    });
    console.log('');
  } catch (error) {
    console.error(`\n  ${RED}✗ Search failed:${RESET}`, error.message);
  }
}

// ─────────────────────────────────────────────────────────
// DUMP HANDLER
// ─────────────────────────────────────────────────────────
async function handleDump() {
  const sinceVal = getFlagValue('--since', args);
  const watchDirVal = getFlagValue('--watch-dir', args);
  
  const logsDir = watchDirVal ? path.resolve(watchDirVal) : DEFAULT_LOGS_DIR;

  if (!fs.existsSync(logsDir)) {
    console.error(`\n  ${RED}✗ Error:${RESET} Logs directory not found at: ${logsDir}\n`);
    process.exit(1);
  }

  let cutoffDate = null;
  if (sinceVal) {
    cutoffDate = chrono.parseDate(sinceVal);
    if (!cutoffDate) {
      console.error(`\n  ${RED}✗ Error:${RESET} Could not parse date "${sinceVal}".\n`);
      process.exit(1);
    }
  }

  console.log(`\n  ${MAGENTA}📁 Dumping raw logs from:${RESET} ${logsDir}`);
  if (cutoffDate) {
    console.log(`  ${DIM}Filtering: modified since ${cutoffDate.toLocaleString()}${RESET}`);
  }
  console.log(`  ${DIM}─────────────────────────────────────────${RESET}`);

  try {
    const files = fs.readdirSync(logsDir);
    let dumpedCount = 0;

    for (const file of files) {
      const fullPath = path.join(logsDir, file);
      const stat = fs.statSync(fullPath);

      if (!stat.isFile()) continue;

      if (cutoffDate && stat.mtime < cutoffDate) {
        continue;
      }

      console.log(`\n  ${BOLD}${CYAN}📄 Log File: ${file}${RESET}`);
      console.log(`  ${DIM}Modified: ${stat.mtime.toLocaleString()} | Size: ${stat.size} bytes${RESET}`);
      console.log(`  ${DIM}─────────────────────────────────────────${RESET}`);
      
      const content = fs.readFileSync(fullPath, 'utf-8');
      console.log(content.trim() ? content : '  (empty file)');
      console.log(`\n  ${DIM}─────────────────────────────────────────${RESET}`);
      dumpedCount++;
    }

    if (dumpedCount === 0) {
      console.log(`\n  ${YELLOW}No files matched dump criteria.${RESET}\n`);
    } else {
      console.log(`\n  ${GREEN}✓ Dumped ${dumpedCount} raw log files.${RESET}\n`);
    }
  } catch (error) {
    console.error(`\n  ${RED}✗ Dump failed:${RESET}`, error.message);
  }
}

// ─────────────────────────────────────────────────────────
// ARCHIVE HANDLER
// ─────────────────────────────────────────────────────────
async function handleArchive() {
  const ageVal = getFlagValue('--age', args) || '30';
  const ageDays = parseInt(ageVal, 10);

  if (isNaN(ageDays) || ageDays < 0) {
    console.error(`\n  ${RED}✗ Error:${RESET} Invalid age value "${ageVal}".\n`);
    process.exit(1);
  }

  console.log(`\n  ${YELLOW}📦 Running LanceDB archival...${RESET}`);
  console.log(`  ${DIM}Archiving memories older than ${ageDays} days...${RESET}\n`);

  try {
    const stats = await archiveMemories({ ageDays });
    console.log(`  ${GREEN}✓ Success:${RESET} ${stats.msg}\n`);
  } catch (error) {
    console.error(`  ${RED}✗ Archival failed:${RESET}`, error.message);
    console.log(`  ${DIM}(If '@lancedb/lancedb' native bindings are missing on this OS, archival is not supported.)${RESET}\n`);
  }
}

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

function getFlagValue(flag, argList) {
  const index = argList.indexOf(flag);
  if (index !== -1 && index + 1 < argList.length) {
    return argList[index + 1];
  }
  return null;
}

function printHelp() {
  console.log(`
  ${BOLD}Baby Daemon — memory CLI (Phase 3)${RESET}

  ${BOLD}USAGE:${RESET}
    memory [search] "<query>" [options]
    memory dump [options]
    memory archive [options]

  ${BOLD}SUBCOMMANDS:${RESET}
    ${CYAN}search${RESET}                  Query stored memories (vector search with keyword fallback)
    ${CYAN}dump${RESET}                    Output raw log file contents directly (bypassing vector search)
    ${CYAN}archive${RESET}                 Move old memories to an archive table to optimize searches

  ${BOLD}SEARCH OPTIONS:${RESET}
    --since "<date>"        Filter memories created since natural language date (e.g. "yesterday", "2 days ago")
    --type <type>           Filter by category (decision, proposed_idea, bug, resolved_bug, architecture_note)
    --file <filename>       Filter by related file path or source chat filename
    --limit <number>        Max results to return (default: 5)

  ${BOLD}DUMP OPTIONS:${RESET}
    --since "<date>"        Dump only logs modified since natural language date
    --watch-dir <path>      Specify folder to read logs from (default: project logs/ folder)

  ${BOLD}ARCHIVE OPTIONS:${RESET}
    --age <days>            Days threshold to move memories to archive (default: 30)

  ${BOLD}EXAMPLES:${RESET}
    memory "caching database strategy"
    memory search "auth bug" --type resolved_bug --since "3 days ago"
    memory dump --since "2 hours ago"
    memory archive --age 14
  `);
}
