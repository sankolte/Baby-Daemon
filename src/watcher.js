/**
 * watcher.js
 * ──────────
 * WHAT THIS FILE DOES:
 *   Sets up chokidar to watch a folder and calls our pipeline when a
 *   file is added or changed. For Phase 1, the "pipeline" is just:
 *     → check idempotency → print filename → mark as processed
 *
 * CONCEPT: chokidar (watch library)
 *   The OS can tell programs "hey, a file changed!" via events.
 *   Node's built-in fs.watch does this, but it's unreliable:
 *     - Fires twice on some OSes
 *     - Doesn't work well across network drives or Docker
 *     - Misses some rename/delete events
 *   chokidar wraps fs.watch AND fs.watchFile and normalizes all of that.
 *   It gives you a clean, reliable event system.
 *   Think of it like: "fs.watch, but fixed."
 *
 * CONCEPT: Event-driven programming
 *   Instead of your program constantly asking "did anything change?"
 *   (called polling), the OS notifies your program when something happens.
 *   chokidar exposes this as events: 'add', 'change', 'unlink' (delete), etc.
 *   You "listen" for events with .on('eventName', callback).
 *   This is the same pattern as addEventListener in the browser.
 */

import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import { isAlreadyProcessed, markAsProcessed } from './idempotency.js';

// ─────────────────────────────────────────────────────────
// MAIN EXPORT: startWatcher(watchPath)
// ─────────────────────────────────────────────────────────

/**
 * startWatcher(watchPath)
 * Starts the file watcher on the given folder path.
 *
 * @param {string} watchPath - The folder to watch (passed from CLI)
 */
export function startWatcher(watchPath) {

  // Verify the folder actually exists before we start
  if (!fs.existsSync(watchPath)) {
    console.error(`\n  ✗ Folder not found: ${watchPath}`);
    console.error(`  Create the folder first, then run memory-watch again.\n`);
    process.exit(1); // Exit with error code 1 (non-zero = something went wrong)
  }

  const resolvedPath = path.resolve(watchPath);
  // path.resolve converts relative paths like "./logs" to absolute ones like "C:/proj101/logs"
  // Always work with absolute paths to avoid confusion

  console.log(`\n  🧠 Baby Daemon — Phase 1 (File Watcher)\n`);
  console.log(`  Watching : ${resolvedPath}`);
  console.log(`  Tracking : processed_keys.json\n`);
  console.log(`  ─────────────────────────────────────────`);

  // ─────────────────────────────────────────────────────────
  // CHOKIDAR SETUP
  // ─────────────────────────────────────────────────────────

  /**
   * CONCEPT: chokidar.watch(path, options)
   *
   * Options explained:
   *
   * persistent: true
   *   Keep the process alive even if there's nothing else running.
   *   Without this, Node might exit immediately after setup.
   *
   * ignoreInitial: true
   *   When you first start watching a folder, chokidar fires 'add' for
   *   EVERY existing file. We don't want that — we only care about NEW changes.
   *   Setting this to true suppresses those initial 'add' events.
   *
   * awaitWriteFinish
   *   This is crucial. When a program saves a large file, it doesn't
   *   write everything at once — the OS writes in chunks.
   *   If we react immediately, we might read an incomplete file.
   *   awaitWriteFinish tells chokidar: "Wait until the file size stops
   *   changing for 500ms before firing the event."
   *   stabilityThreshold: 500ms of no changes = "write is done"
   *   pollInterval: check every 100ms during that wait period
   *
   * usePolling: false
   *   Polling = constantly checking "did this file change?" every N ms.
   *   Event-based = OS tells us immediately. Event-based is better (less CPU).
   *   usePolling: false means "use OS events, not polling".
   *   (Set to true if watching network drives or Docker volumes)
   */
  const watcher = chokidar.watch(resolvedPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
    usePolling: false,
  });

  // ─────────────────────────────────────────────────────────
  // EVENT LISTENERS
  // ─────────────────────────────────────────────────────────

  /**
   * CONCEPT: .on('event', callback)
   *   chokidar is an EventEmitter — a Node.js pattern where an object
   *   can emit named events, and you register functions to handle them.
   *   watcher.on('add', fn)    → fn runs when a NEW file appears
   *   watcher.on('change', fn) → fn runs when an existing file changes
   *
   *   The callback receives:
   *     filePath: absolute path of the changed file
   *     stats:    file statistics object (size, modified time, etc.)
   *               Only available because we'll use it for idempotency
   */

  // Handle new files added to the folder
  watcher.on('add', (filePath, stats) => {
    handleFileEvent('NEW FILE', filePath, stats);
  });

  // Handle existing files that get modified
  watcher.on('change', (filePath, stats) => {
    handleFileEvent('MODIFIED', filePath, stats);
  });

  // If something goes wrong with the watcher itself
  watcher.on('error', (error) => {
    console.error(`\n  ✗ Watcher error: ${error.message}\n`);
  });

  // Fires once chokidar has finished its initial scan and is ready
  watcher.on('ready', () => {
    console.log(`  ✓ Watcher is live. Waiting for file changes...\n`);
  });

  // ─────────────────────────────────────────────────────────
  // GRACEFUL SHUTDOWN
  // ─────────────────────────────────────────────────────────

  /**
   * CONCEPT: process signals (SIGINT, SIGTERM)
   *   When you press Ctrl+C in the terminal, the OS sends a signal called
   *   SIGINT (Signal Interrupt) to your process.
   *   By default, Node exits immediately. But we want to close the watcher
   *   cleanly first (release file handles, etc.).
   *   process.on('SIGINT', fn) lets us intercept that signal and run cleanup.
   */
  process.on('SIGINT', async () => {
    console.log('\n\n  Shutting down watcher...');
    await watcher.close(); // Tell chokidar to stop watching
    console.log('  ✓ Watcher stopped. Goodbye.\n');
    process.exit(0); // Exit with code 0 = clean exit
  });
}

// ─────────────────────────────────────────────────────────
// HANDLE A SINGLE FILE EVENT
// ─────────────────────────────────────────────────────────

/**
 * handleFileEvent(eventType, filePath, stats)
 *
 * This is our Phase 1 "pipeline" — just idempotency check + print.
 * In Phase 2, this is where we'll add the LLM summarization call.
 *
 * @param {string} eventType - 'NEW FILE' or 'MODIFIED'
 * @param {string} filePath  - Absolute path to the changed file
 * @param {object} stats     - fs.Stats object from chokidar
 *
 * CONCEPT: fs.Stats object
 *   When chokidar detects a change, it can pass you an fs.Stats object.
 *   This contains metadata about the file:
 *     stats.size    → file size in bytes
 *     stats.mtimeMs → last modified time in milliseconds since Unix epoch
 *                     (Jan 1, 1970 00:00:00 UTC)
 *   We use mtimeMs as part of our idempotency key.
 *
 * CONCEPT: Optional chaining (stats?.mtimeMs)
 *   chokidar might not always provide stats (e.g., on some OS events).
 *   stats?.mtimeMs means: "if stats exists, get mtimeMs; if not, return undefined"
 *   Without ?. we'd crash if stats is undefined.
 *   Fallback: Date.now() gives us current time in ms as a substitute.
 */
function handleFileEvent(eventType, filePath, stats) {
  const mtimeMs = stats?.mtimeMs ?? Date.now();
  // ?? is the "nullish coalescing" operator: use right side if left is null or undefined

  const relativePath = path.basename(filePath);
  // path.basename gets just the filename from a full path
  // "C:/proj101/logs/chat_042.md" → "chat_042.md"

  // ── IDEMPOTENCY CHECK ──────────────────────────────────
  if (isAlreadyProcessed(filePath, mtimeMs)) {
    console.log(`  [SKIP]  ${relativePath}  (already processed)`);
    return; // Stop here — don't process again
  }

  // ── NEW / CHANGED FILE — PROCESS IT ───────────────────
  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n  [${eventType}]  ${relativePath}`);
  console.log(`  Time   : ${timestamp}`);
  console.log(`  Path   : ${filePath}`);
  console.log(`  Size   : ${stats?.size ?? 'unknown'} bytes`);
  console.log(`  ─────────────────────────────────────────`);

  // Phase 1: nothing else to do yet — just mark as processed
  // Phase 2: this is where we'll call the LLM summarizer
  markAsProcessed(filePath, mtimeMs);
  console.log(`  ✓ Recorded. Ready for next change.\n`);
}
