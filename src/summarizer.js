import { ai } from './config.js';
import crypto from 'crypto';

// ─────────────────────────────────────────────────────────
// SYSTEM INSTRUCTION & JSON SCHEMA
// ─────────────────────────────────────────────────────────

const systemInstruction = `You are a context compression engine for an AI coding assistant memory system.
Your job is to analyze the raw conversation log (or file contents) provided by the user and extract key technical developments into structured JSON memories.

For each memory:
- 'type': Categorize it as:
  * 'decision' (only if both developer and assistant explicitly agreed and committed to something)
  * 'proposed_idea' (ideas discussed but not yet implemented or decided)
  * 'rejected_idea' (ideas considered and discarded)
  * 'open_question' (questions remaining unresolved)
  * 'bug' (bugs discovered during the session)
  * 'resolved_bug' (bugs fixed during the session)
  * 'architecture_note' (architectural or design details noted)
  * 'file_change' (files created, modified, or deleted)
- 'content': A concise declarative statement summarizing the memory. Maintain precision: do not turn a 'maybe/proposal' into a 'completed migration'. Be clear about certainty.
- 'original_text': The exact quote or sentence from the log that provides evidence for this memory.
- 'confidence': A score between 0.0 (very tentative suggestion) and 1.0 (firm/confirmed fact).
- 'related_files': List any files mentioned in the context of this memory.
- 'tags': Simple, descriptive lowercase tags for keyword indexing (e.g. 'auth', 'redis', 'security').

Ignore small talk, greetings, minor formatting adjustments, or repetitive debugging output. Keep only information that is vital for another AI assistant or human developer continuing the project later.`;

const responseSchema = {
  type: 'OBJECT',
  properties: {
    memories: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          type: {
            type: 'STRING',
            enum: [
              'decision',
              'proposed_idea',
              'rejected_idea',
              'open_question',
              'bug',
              'resolved_bug',
              'architecture_note',
              'file_change'
            ]
          },
          content: { type: 'STRING' },
          original_text: { type: 'STRING' },
          confidence: { type: 'NUMBER' },
          related_files: {
            type: 'ARRAY',
            items: { type: 'STRING' }
          },
          tags: {
            type: 'ARRAY',
            items: { type: 'STRING' }
          }
        },
        required: [
          'type',
          'content',
          'original_text',
          'confidence',
          'related_files',
          'tags'
        ]
      }
    }
  },
  required: ['memories']
};

// ─────────────────────────────────────────────────────────
// HELPER: GENERATE HASH
// ─────────────────────────────────────────────────────────

/**
 * generateMemoryHash(memory)
 * Computes a SHA-256 hash based on core fields to prevent duplicate extraction of the same point.
 */
function generateMemoryHash(memory) {
  const raw = `${memory.type}|${memory.content}|${memory.original_text}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ─────────────────────────────────────────────────────────
// MAIN EXPORT: summarizeChatLog
// ─────────────────────────────────────────────────────────

/**
 * summarizeChatLog(fileContent, fileName)
 *
 * Calls the Gemini API to extract structured memories from the log.
 *
 * @param {string} fileContent - The text of the chat log/file
 * @param {string} fileName    - The name of the file (for source reference)
 * @returns {Promise<Array>}   - Array of enriched memory objects
 */
export async function summarizeChatLog(fileContent, fileName) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set in environment or .env file.');
  }

  const prompt = `Here is the content of the file "${fileName}":\n\n${fileContent}`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema,
      }
    });

    if (!response.text) {
      throw new Error('Received empty response text from Gemini API.');
    }

    const parsed = JSON.parse(response.text);
    const rawMemories = parsed.memories || [];

    // Map to enriched structure with IDs, timestamps, and hashes
    return rawMemories.map((mem) => {
      const enriched = {
        id: `mem-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        timestamp: new Date().toISOString(),
        type: mem.type,
        content: mem.content,
        original_text: mem.original_text,
        confidence: mem.confidence,
        status: 'active',
        related_files: mem.related_files || [],
        tags: mem.tags || [],
        source: {
          chat_file: fileName,
        },
      };
      enriched.hash = generateMemoryHash(enriched);
      return enriched;
    });

  } catch (error) {
    console.error(`\n  ✗ Error during Gemini summarization for ${fileName}:`, error.message);
    throw error;
  }
}
