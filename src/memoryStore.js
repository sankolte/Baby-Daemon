import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get path to memory.jsonl in the project root folder
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.join(__dirname, '..', 'memory.jsonl');

/**
 * saveMemoriesForFile(fileName, memories)
 * Updates memory.jsonl by removing any old memories belonging to the given
 * fileName and appending the newly extracted memories. Uses an atomic write.
 *
 * @param {string} fileName - Name of the source chat file
 * @param {Array} memories - List of enriched memory objects
 * @returns {number} The number of memories saved
 */
export function saveMemoriesForFile(fileName, memories) {
  try {
    let allMemories = [];

    // Read existing memories if file exists
    if (fs.existsSync(MEMORY_FILE)) {
      const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
      allMemories = content
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean); // Filter out any null/parsed failures
    }

    // Filter out any existing memories that came from this specific file
    const filteredMemories = allMemories.filter(
      (mem) => mem.source?.chat_file !== fileName
    );

    // Normalize: ensure every incoming memory's source.chat_file matches fileName
    // This prevents mismatches if memories were generated under a different name
    const normalizedMemories = memories.map(mem => ({
      ...mem,
      source: { ...mem.source, chat_file: fileName }
    }));

    // Merge in the new memories
    const updatedMemories = [...filteredMemories, ...normalizedMemories];

    // Convert objects to JSON lines (JSONL format)
    const linesToWrite = updatedMemories.map((mem) => JSON.stringify(mem)).join('\n') + '\n';

    // Atomic write: write to temp file then rename
    const tempFile = MEMORY_FILE + '.tmp';
    fs.writeFileSync(tempFile, linesToWrite, 'utf-8');
    fs.renameSync(tempFile, MEMORY_FILE);

    return memories.length;
  } catch (error) {
    console.error(`Error saving memories for file ${fileName}:`, error.message);
    throw error;
  }
}
