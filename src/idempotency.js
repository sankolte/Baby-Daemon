/**
 * idempotency.js
 * ──────────────
 * WHAT THIS FILE DOES:
 *   Prevents us from processing the same file version twice.
 *   Every time a file changes, we generate a unique "fingerprint" for it.
 *   If we've seen that fingerprint before → skip. If new → process.
 *
 * CONCEPT: Idempotency
 *   "Idempotent" means: doing something twice = doing it once.
 *   Example: pressing an elevator button twice doesn't call it twice.
 *   We want the same guarantee: even if the watcher fires 5 times for
 *   the same file save, we process it exactly once.
 *
 * CONCEPT: SHA-256 Hash
 *   A hash function takes ANY input (text, file path, anything)
 *   and produces a fixed-length "fingerprint" string.
 *   - Same input → ALWAYS same output
 *   - Different input → different output (even 1 char difference)
 *   - You CANNOT reverse it (you can't get the input back from the hash)
 *   SHA-256 produces a 64-character hex string, e.g: "a3f9b2c1..."
 *   Node.js has this built-in via the 'crypto' module.
 */

import crypto from 'crypto';  // Built-in Node.js module — no install needed
import fs from 'fs';           // File System module — also built-in
import path from 'path';       // Path utilities — also built-in

// ─────────────────────────────────────────────────────────
// WHERE WE STORE PROCESSED KEYS
// ─────────────────────────────────────────────────────────

/**
 * CONCEPT: __dirname equivalent in ES Modules
 *   In older Node.js (CommonJS), you had __dirname for "this file's folder".
 *   With modern ES Modules (which we use, see "type": "module" in package.json),
 *   you use import.meta.url instead.
 *   new URL('.', import.meta.url).pathname gives us the current directory.
 */
const __dirname = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
// The replace() above fixes a Windows quirk: Node gives "/C:/..." but Windows needs "C:/..."

const KEYS_FILE = path.join(__dirname, '..', 'processed_keys.json');
// path.join builds a file path correctly for any OS
// '..' means "go up one folder" (from src/ to proj101/)
// Result: proj101/processed_keys.json

// ─────────────────────────────────────────────────────────
// LOAD KEYS FROM DISK
// ─────────────────────────────────────────────────────────

/**
 * loadKeys()
 * Reads the processed_keys.json file from disk and returns it as a JS Set.
 *
 * CONCEPT: Set vs Array
 *   Array: ordered list, allows duplicates, checking "does X exist?" = slow (scans every item)
 *   Set:   unordered collection, NO duplicates, checking "does X exist?" = instant (O(1))
 *   For idempotency we only care about "have I seen this key?" → Set is perfect.
 *
 * CONCEPT: try/catch
 *   If the file doesn't exist yet (first run), fs.readFileSync throws an error.
 *   We catch it and return an empty Set instead of crashing.
 */
function loadKeys() {
  try {
    const raw = fs.readFileSync(KEYS_FILE, 'utf-8');
    // JSON.parse converts the JSON string into a JS object/array
    const arr = JSON.parse(raw);
    // We stored it as an array (JSON doesn't support Set), so we convert back
    return new Set(arr);
  } catch {
    // File doesn't exist yet → start with empty Set
    return new Set();
  }
}

// ─────────────────────────────────────────────────────────
// SAVE KEYS TO DISK
// ─────────────────────────────────────────────────────────

/**
 * saveKeys(keys)
 * Writes the current Set of keys to processed_keys.json on disk.
 *
 * CONCEPT: Why save to disk at all?
 *   If we only kept keys in memory (a variable), they'd be lost when the
 *   program restarts. Saving to a JSON file makes them persistent across runs.
 *
 * CONCEPT: JSON.stringify with formatting
 *   JSON.stringify(value, null, 2) converts a JS value to a JSON string.
 *   The '2' means "indent with 2 spaces" → human-readable file.
 */
function saveKeys(keys) {
  // Convert Set to Array because JSON.stringify can't handle Set directly
  const arr = Array.from(keys);
  fs.writeFileSync(KEYS_FILE, JSON.stringify(arr, null, 2), 'utf-8');
}

// ─────────────────────────────────────────────────────────
// GENERATE THE IDEMPOTENCY KEY
// ─────────────────────────────────────────────────────────

/**
 * getIdempotencyKey(filePath, mtimeMs)
 *
 * @param {string} filePath - Absolute path of the file, e.g. "C:/logs/chat_42.md"
 * @param {number} mtimeMs  - Last modified time in milliseconds (from fs.stat)
 * @returns {string}        - A 64-char SHA-256 hex string
 *
 * CONCEPT: Why combine path + mtime?
 *   Path alone: same file modified twice would have same key → would skip the 2nd change
 *   Mtime alone: two different files modified at same ms could collide (unlikely but possible)
 *   Together: unique fingerprint for "this exact file at this exact version"
 *
 * CONCEPT: Digest formats
 *   .digest('hex') = output as hexadecimal string (0-9, a-f) → easy to store, read, compare
 *   Other options: 'base64', 'binary' — hex is the most human-readable
 */
export function getIdempotencyKey(filePath, mtimeMs) {
  const raw = filePath + '|' + mtimeMs;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ─────────────────────────────────────────────────────────
// THE MAIN CHECK: Have we already processed this file version?
// ─────────────────────────────────────────────────────────

/**
 * isAlreadyProcessed(filePath, mtimeMs)
 * Returns true if this exact file version was processed before.
 * Returns false if it's new (and you should process it).
 */
export function isAlreadyProcessed(filePath, mtimeMs) {
  const keys = loadKeys();
  const key = getIdempotencyKey(filePath, mtimeMs);
  return keys.has(key); // Set.has() is O(1) — instant lookup
}

// ─────────────────────────────────────────────────────────
// MARK A FILE VERSION AS PROCESSED
// ─────────────────────────────────────────────────────────

/**
 * markAsProcessed(filePath, mtimeMs)
 * Call this AFTER successfully processing a file.
 * Adds the key to the store and persists it to disk.
 *
 * IMPORTANT: We only call this AFTER success.
 * If processing fails halfway, we don't record the key,
 * so the next run will retry it. That's intentional.
 */
export function markAsProcessed(filePath, mtimeMs) {
  const keys = loadKeys();
  const key = getIdempotencyKey(filePath, mtimeMs);
  keys.add(key);
  saveKeys(keys);
}
