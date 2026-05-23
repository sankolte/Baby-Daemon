import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.warn(
    '\n  ⚠️  Warning: GEMINI_API_KEY is not set in your environment or .env file.\n' +
    '  Please create a .env file in the project root with your API key:\n' +
    '  GEMINI_API_KEY=your_free_gemini_api_key_here\n'
  );
}

// Initialize the Gemini API client
export const ai = new GoogleGenAI({ apiKey });
