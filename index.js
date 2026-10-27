#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerMediaTools } from './tools/media.js';
import { registerFileTools } from './tools/files.js';
import { registerGeminiTools } from './tools/gemini.js';
import { registerResearchTools } from './tools/research.js';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const server = new McpServer(
  { name: 'gemini-mcp-server', version: pkg.version },
  {
    instructions:
      'Gemini perception tools. Use gemini_analyze_video to watch videos, gemini_analyze_audio to ' +
      'listen to audio, and gemini_transcribe_audio for transcripts with speaker labels and timestamps. ' +
      'Sources can be absolute local paths, Files API names, https/gs URLs, or YouTube URLs for video. ' +
      'For several questions about the same large file, upload it once with gemini_upload_file and ' +
      'pass the returned files/... name as the source. gemini_deep_research produces cited web research ' +
      'reports, gemini_embed creates multimodal embeddings, and gemini_chat asks Gemini for a second opinion.',
  },
);

registerMediaTools(server);
registerFileTools(server);
registerGeminiTools(server);
registerResearchTools(server);

await server.connect(new StdioServerTransport());
