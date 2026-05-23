#!/usr/bin/env node
/**
 * memory-watch.js  (the CLI entry point)
 * ────────────────────────────────────────
 * WHAT THIS FILE DOES:
 *   This is the file that runs when you type `memory-watch` in the terminal.
 *   It reads the command-line arguments, validates them, and calls startWatcher().
 *   It's intentionally tiny — a CLI entry point should ONLY parse args and delegate.
 *   All real logic lives in src/watcher.js.
 *
 * CONCEPT: #!/usr/bin/env node  (the "shebang" line)
 *   The very first line starting with #! is called a "shebang" (or hashbang).
 *   On Unix/Mac, when you run a script file directly, the OS reads this line
 *   to know WHICH program should execute the file.
 *   #!/usr/bin/env node means: "find 'node' in the PATH and run this file with it"
 *   On Windows this line is ignored (Node handles it differently via the bin field
 *   in package.json), but we still include it for cross-platform compatibility.
 *
 * CONCEPT: process.argv
 *   Every Node.js process has a global 'process' object with useful info.
 *   process.argv is an array of command-line arguments:
 *     process.argv[0] = path to node executable (e.g., "C:/nodejs/node.exe")
 *     process.argv[1] = path to the script being run (e.g., "C:/proj101/bin/memory-watch.js")
 *     process.argv[2] = FIRST argument YOU passed (e.g., "./logs")
 *     process.argv[3] = second argument (if any)
 *   So when you run: memory-watch ./logs
 *   process.argv = ['node', 'memory-watch.js', './logs']
 *   And process.argv[2] = './logs'
 *
 * CONCEPT: ES Module imports
 *   We use: import { startWatcher } from '../src/watcher.js';
 *   This is the modern JS module system (ESM).
 *   The older system (CommonJS) used: const { startWatcher } = require('../src/watcher');
 *   We use ESM because we set "type": "module" in package.json.
 *   Key difference: ESM is static (imports resolved at parse time), CJS is dynamic.
 */

import { startWatcher } from '../src/watcher.js';

// ─────────────────────────────────────────────────────────
// PARSE ARGUMENTS
// ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
// .slice(2) removes the first two items (node path + script path)
// leaving only the arguments the user actually typed

// Show help if user runs: memory-watch --help  or  memory-watch -h
if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

// The watch path is the first real argument
const watchPath = args[0];

if (!watchPath) {
  console.error('\n  ✗ Error: No folder path provided.\n');
  printHelp();
  process.exit(1);
}

// ─────────────────────────────────────────────────────────
// START THE WATCHER
// ─────────────────────────────────────────────────────────

startWatcher(watchPath);

// ─────────────────────────────────────────────────────────
// HELP TEXT
// ─────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
  Baby Daemon — memory-watch (Phase 1)

  USAGE:
    memory-watch <folder-path>

  EXAMPLES:
    memory-watch ./logs
    memory-watch C:/Users/you/ai-chat-logs
    memory-watch .            (watch current folder)

  WHAT IT DOES:
    Watches <folder-path> for new and modified files.
    Prints detected files and skips duplicates (idempotency check).
    Saves processed file fingerprints to processed_keys.json.

  STOP:
    Press Ctrl+C to stop the watcher gracefully.
  `);
}
