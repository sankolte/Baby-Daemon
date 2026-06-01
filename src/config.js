import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env from the current working directory (user's project root)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(process.cwd(), '.env') });

// Also try loading from the package root (for global installs)
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.warn(
    '\n  ⚠️  Warning: GEMINI_API_KEY is not set in your environment or .env file.\n' +
    '  Please create a .env file in the project root with your API key:\n' +
    '  GEMINI_API_KEY=your_free_gemini_api_key_here\n'
  );
}

// Initialize the Gemini API client.
// Use a placeholder when no key is set so the SDK doesn't throw a raw error
// on import (e.g. when running `memory --help` or `baby-daemon`).
// Any actual API call will still fail gracefully with a meaningful auth error.
export const ai = new GoogleGenAI({ apiKey: apiKey || 'MISSING_KEY_SEE_WARNING_ABOVE' });
