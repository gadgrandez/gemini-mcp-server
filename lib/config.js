import { GoogleGenAI } from '@google/genai';

const THINKING_LEVELS = ['low', 'medium', 'high'];
const MEDIA_RESOLUTIONS = ['low', 'medium', 'high', 'ultra_high'];

function readBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function readEnum(name, allowed, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')} (got "${raw}")`);
  }
  return value;
}

function readInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}

if (!process.env.GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY environment variable is required. See README.md for setup.');
}

export const config = Object.freeze({
  model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  transcribeModel: process.env.GEMINI_TRANSCRIBE_MODEL || 'gemini-3.5-transcribe',
  embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2',
  researchAgent: process.env.GEMINI_RESEARCH_AGENT || 'deep-research-preview-04-2026',
  researchMaxAgent: process.env.GEMINI_RESEARCH_MAX_AGENT || 'deep-research-max-preview-04-2026',
  thinkingLevel: readEnum('GEMINI_THINKING_LEVEL', THINKING_LEVELS, 'low'),
  mediaResolution: readEnum('GEMINI_MEDIA_RESOLUTION', MEDIA_RESOLUTIONS, 'medium'),
  store: readBool('GEMINI_STORE', false),
  keepUploads: readBool('GEMINI_KEEP_UPLOADS', false),
  timeoutMs: readInt('GEMINI_TIMEOUT_MS', 15 * 60 * 1000),
  inlineMaxBytes: readInt('GEMINI_INLINE_MAX_MB', 20) * 1024 * 1024,
});

const httpOptions = { timeout: config.timeoutMs };
if (process.env.GEMINI_BASE_URL) httpOptions.baseUrl = process.env.GEMINI_BASE_URL;

export const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions });

export { THINKING_LEVELS, MEDIA_RESOLUTIONS };
