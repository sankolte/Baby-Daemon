import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { ai } from './config.js';

// Resolve __dirname equivalent in ES Modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, '.lancedb');
const CACHE_FILE = path.join(PROJECT_ROOT, '.embeddings_cache.json');
const MEMORY_FILE = path.join(PROJECT_ROOT, 'memory.jsonl');

// Dynamically import LanceDB to handle native compilation failures gracefully
let lancedb = null;
let isLanceDbAvailable = false;

try {
  // Use dynamic import so it parses at runtime inside the try block
  lancedb = await import('@lancedb/lancedb');
  isLanceDbAvailable = true;
} catch (error) {
  console.warn(
    '\n  ⚠️  Warning: Failed to load `@lancedb/lancedb` native bindings.\n' +
    '  Baby Daemon will automatically run in fallback mode using pure JS MiniSearch.\n' +
    `  Error details: ${error.message}\n`
  );
}

// ─────────────────────────────────────────────────────────
// EMBEDDING CACHE READ/WRITE
// ─────────────────────────────────────────────────────────

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    }
  } catch (error) {
    console.error('  ⚠️  Failed to read embedding cache:', error.message);
  }
  return {};
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (error) {
    console.error('  ⚠️  Failed to save embedding cache:', error.message);
  }
}

// ─────────────────────────────────────────────────────────
// GET BATCH EMBEDDINGS (WITH LOCAL CACHING)
// ─────────────────────────────────────────────────────────

/**
 * getEmbeddingsForMemories(memories)
 *
 * @param {Array} memories - List of raw memory objects
 * @returns {Promise<Array>} - List of memories enriched with their embedding vectors
 */
export async function getEmbeddingsForMemories(memories) {
  if (memories.length === 0) return [];

  const cache = loadCache();
  const missingHashes = [];
  const textsToEmbed = [];

  // Determine which memories need embeddings generated
  for (const mem of memories) {
    if (!cache[mem.hash]) {
      missingHashes.push(mem.hash);
      // Construct a rich string representation for embedding context
      // Including the type helps match queries like "what bug" or "what decision"
      const richText = `[${mem.type.toUpperCase()}] ${mem.content} (Files: ${mem.related_files.join(', ')})`;
      textsToEmbed.push(richText);
    }
  }

  // Fetch embeddings from Gemini API for any cache misses
  if (textsToEmbed.length > 0) {
    try {
      const response = await ai.models.embedContent({
        model: 'gemini-embedding-2',
        contents: textsToEmbed,
      });

      if (response && response.embeddings) {
        for (let i = 0; i < response.embeddings.length; i++) {
          const vector = response.embeddings[i].values;
          const hash = missingHashes[i];
          cache[hash] = vector;
        }
        saveCache(cache);
      } else {
        throw new Error('Invalid response structure from Gemini Embedding API');
      }
    } catch (error) {
      console.error('  ✗ Error calling Gemini Embedding API:', error.message);
      throw error;
    }
  }

  // Map all memories to their vectorized version
  return memories.map((mem) => ({
    id: mem.id,
    vector: cache[mem.hash],
    type: mem.type,
    content: mem.content,
    original_text: mem.original_text,
    confidence: mem.confidence,
    status: mem.status || 'active',
    related_files: mem.related_files || [],
    tags: mem.tags || [],
    chat_file: mem.source?.chat_file || 'unknown',
    timestamp: mem.timestamp || new Date().toISOString(),
    hash: mem.hash,
  }));
}

// ─────────────────────────────────────────────────────────
// SYNCHRONIZE MEMORIES WITH LANCEDB
// ─────────────────────────────────────────────────────────

/**
 * syncMemoriesToVectorStore(fileName, memories)
 * Updates LanceDB by replacing all memories associated with fileName.
 *
 * @param {string} fileName - Source file name
 * @param {Array} memories - List of raw memory objects
 */
export async function syncMemoriesToVectorStore(fileName, memories) {
  if (!isLanceDbAvailable) {
    return; // Fallback mode silently bypasses LanceDB
  }

  try {
    const db = await lancedb.connect(DB_PATH);
    const tableNames = await db.tableNames();
    let table;

    // Get vectorized memories (using cache / calling API)
    const vectorizedMemories = await getEmbeddingsForMemories(memories);

    if (tableNames.includes('memories')) {
      table = await db.openTable('memories');
      
      // Delete old records for this file (in-place soft delete)
      // SQL-like syntax required by LanceDB
      await table.delete(`chat_file = '${fileName}'`);

      // Add new ones
      if (vectorizedMemories.length > 0) {
        await table.add(vectorizedMemories);
      }
    } else {
      // Create table if it doesn't exist
      if (vectorizedMemories.length > 0) {
        table = await db.createTable('memories', vectorizedMemories);
      }
    }
  } catch (error) {
    console.error(`  ⚠️ LanceDB sync failed for ${fileName}:`, error.message);
  }
}

// ─────────────────────────────────────────────────────────
// SEARCH MEMORIES (SEMANTIC + KEYWORD FALLBACK)
// ─────────────────────────────────────────────────────────

/**
 * searchMemories(queryText, filters)
 * Performs hybrid semantic search with date and field filters, falling back to MiniSearch if needed.
 *
 * @param {string} queryText - Query string
 * @param {Object} filters - Filter arguments (since, type, file, limit)
 */
export async function searchMemories(queryText, filters = {}) {
  const { since, type, file, limit = 10 } = filters;

  // ── LAYER 1: LanceDB Vector Search (Semantic) ─────────────────────
  if (isLanceDbAvailable) {
    try {
      const db = await lancedb.connect(DB_PATH);
      const tableNames = await db.tableNames();

      if (tableNames.includes('memories')) {
        const table = await db.openTable('memories');

        // Generate embedding for the query
        const queryEmbeddingRes = await ai.models.embedContent({
          model: 'gemini-embedding-2',
          contents: queryText,
        });
        const queryVector = queryEmbeddingRes.embeddings[0].values;

        // Perform vector search using cosine distance
        const results = await table
          .vectorSearch(queryVector)
          .distanceType('cosine')
          .limit(100) // Retrieve more to allow client-side filtering
          .toArray();

        // Map and score: cosine similarity is (1 - cosine distance)
        const scoredResults = results.map(item => {
          const toJSArray = (val) => {
            if (!val) return [];
            if (Array.isArray(val)) return val;
            if (typeof val.toArray === 'function') return val.toArray();
            return Array.from(val);
          };
          return {
            ...item,
            related_files: toJSArray(item.related_files),
            tags: toJSArray(item.tags),
            score: 1 - (item._distance ?? 1),
          };
        });

        // Filter by threshold (score >= 0.50)
        let filtered = scoredResults.filter(item => item.score >= 0.50);

        // Apply metadata filters
        if (filtered.length > 0) {
          filtered = applyFilters(filtered, { since, type, file });
          if (filtered.length > 0) {
            return {
              method: 'semantic',
              results: filtered.slice(0, limit),
            };
          }
        }
      }
    } catch (error) {
      console.warn('  ⚠️ Vector search failed, falling back to full-text:', error.message);
    }
  }

  // ── LAYER 2: MiniSearch Keyword Fallback ─────────────────────────
  console.log('  [Search] Falling back to keyword-based search...');
  return {
    method: 'keyword',
    results: await searchMiniSearch(queryText, { since, type, file, limit }),
  };
}

// ─────────────────────────────────────────────────────────
// METADATA FILTERING HELPER
// ─────────────────────────────────────────────────────────

function applyFilters(results, { since, type, file }) {
  let filtered = [...results];

  // Filter by date (since)
  if (since) {
    const cutoffDate = new Date(since);
    if (!isNaN(cutoffDate.getTime())) {
      filtered = filtered.filter(item => new Date(item.timestamp) >= cutoffDate);
    }
  }

  // Filter by type
  if (type) {
    const targetType = type.trim().toLowerCase();
    filtered = filtered.filter(item => item.type.toLowerCase() === targetType);
  }

  // Filter by file
  if (file) {
    const targetFile = file.trim().toLowerCase();
    filtered = filtered.filter(item => {
      const matchSource = item.chat_file.toLowerCase().includes(targetFile);
      const matchRelated = item.related_files.some(f => f.toLowerCase().includes(targetFile));
      return matchSource || matchRelated;
    });
  }

  return filtered;
}

// ─────────────────────────────────────────────────────────
// MINISEARCH FALLBACK RUNNER
// ─────────────────────────────────────────────────────────

async function searchMiniSearch(queryText, { since, type, file, limit }) {
  if (!fs.existsSync(MEMORY_FILE)) {
    return [];
  }

  try {
    const MiniSearch = (await import('minisearch')).default;

    // Load and parse flat memory file
    const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
    const documents = content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          const parsed = JSON.parse(line);
          return {
            id: parsed.id,
            type: parsed.type,
            content: parsed.content,
            original_text: parsed.original_text,
            confidence: parsed.confidence,
            status: parsed.status,
            related_files: parsed.related_files,
            tags: parsed.tags,
            chat_file: parsed.source?.chat_file || 'unknown',
            timestamp: parsed.timestamp,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // Initialize MiniSearch engine
    const miniSearch = new MiniSearch({
      fields: ['content', 'original_text', 'tags', 'related_files', 'type'],
      storeFields: [
        'id',
        'type',
        'content',
        'original_text',
        'confidence',
        'status',
        'related_files',
        'tags',
        'chat_file',
        'timestamp',
      ],
      searchOptions: {
        fuzzy: 0.2,
        prefix: true,
      },
    });

    miniSearch.addAll(documents);

    // Search and score
    const results = miniSearch.search(queryText);

    // Apply metadata filters
    return applyFilters(results, { since, type, file }).slice(0, limit);
  } catch (error) {
    console.error('  ✗ Keyword search fallback failed:', error.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────
// ARCHIVE MEMORIES
// ─────────────────────────────────────────────────────────

/**
 * archiveMemories(ageDays)
 * Moves memories older than ageDays from 'memories' to 'archived_memories' table.
 *
 * @param {Object} options - Age options
 * @returns {Promise<Object>} - Archival statistics
 */
export async function archiveMemories({ ageDays = 30 } = {}) {
  if (!isLanceDbAvailable) {
    throw new Error('LanceDB is not available on this platform.');
  }

  try {
    const db = await lancedb.connect(DB_PATH);
    const tableNames = await db.tableNames();

    if (!tableNames.includes('memories')) {
      return { archivedCount: 0, msg: 'No memories table exists yet.' };
    }

    const table = await db.openTable('memories');
    const allMemories = await table.query().toArray();

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - ageDays);

    const toArchive = allMemories.filter(m => new Date(m.timestamp) < cutoff);

    if (toArchive.length === 0) {
      return { archivedCount: 0, msg: `No memories older than ${ageDays} days found.` };
    }

    let archiveTable;
    if (tableNames.includes('archived_memories')) {
      archiveTable = await db.openTable('archived_memories');
      await archiveTable.add(toArchive);
    } else {
      archiveTable = await db.createTable('archived_memories', toArchive);
    }

    // Delete from main memories table
    const ids = toArchive.map(m => `'${m.id}'`).join(',');
    await table.delete(`id IN (${ids})`);

    return {
      archivedCount: toArchive.length,
      msg: `Archived ${toArchive.length} memories (older than ${ageDays} days) successfully.`,
    };
  } catch (error) {
    console.error('  ✗ Archival failed:', error.message);
    throw error;
  }
}

// ─────────────────────────────────────────────────────────
// RESYNC ALL MEMORIES FROM memory.jsonl → LanceDB
// ─────────────────────────────────────────────────────────

/**
 * resyncAllMemories()
 * Reads memory.jsonl and syncs any chat_file groups that are
 * missing from the LanceDB memories table (e.g. were processed
 * before LanceDB was set up, or after a DB reset).
 *
 * @returns {Promise<Object>} - { synced, skipped, total }
 */
export async function resyncAllMemories() {
  if (!fs.existsSync(MEMORY_FILE)) {
    return { synced: 0, skipped: 0, total: 0, msg: 'No memory.jsonl found.' };
  }

  // Load all memories from flat file
  const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
  const allMemories = content
    .split('\n')
    .filter(line => line.trim())
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);

  if (allMemories.length === 0) {
    return { synced: 0, skipped: 0, total: 0, msg: 'memory.jsonl is empty.' };
  }

  // Group by source chat_file
  const byFile = {};
  for (const mem of allMemories) {
    const key = mem.source?.chat_file || 'unknown';
    if (!byFile[key]) byFile[key] = [];
    byFile[key].push(mem);
  }

  // Find which files are already in LanceDB (skip those)
  let existingFiles = new Set();
  if (isLanceDbAvailable) {
    try {
      const db = await lancedb.connect(DB_PATH);
      const tableNames = await db.tableNames();
      if (tableNames.includes('memories')) {
        const table = await db.openTable('memories');
        const rows = await table.query().toArray();
        existingFiles = new Set(rows.map(r => r.chat_file));
      }
    } catch (e) {
      // Non-fatal — will attempt full resync
    }
  }

  const missingFiles = Object.keys(byFile).filter(f => !existingFiles.has(f));
  let synced = 0;

  for (const chatFile of missingFiles) {
    const memories = byFile[chatFile];
    await syncMemoriesToVectorStore(chatFile, memories);
    synced += memories.length;
  }

  const skipped = allMemories.length - synced;
  return {
    synced,
    skipped,
    total: allMemories.length,
    syncedFiles: missingFiles,
    msg: missingFiles.length === 0
      ? 'LanceDB is already up to date — no missing entries found.'
      : `Synced ${synced} memories from ${missingFiles.length} file(s): ${missingFiles.join(', ')}`,
  };
}
