import { z } from 'zod';
import { config, THINKING_LEVELS, MEDIA_RESOLUTIONS } from '../lib/config.js';
import { resolveSource } from '../lib/sources.js';
import { runInteraction, usageLine } from '../lib/run.js';
import { formatWordTranscript, parseOffset } from '../lib/format.js';
import { success, failure, withHeartbeat } from './result.js';

const SOURCE_DESCRIPTION = 'Absolute local file path, Files API name (files/...), https:// URL or gs:// URI';

const common = {
  model: z.string().optional().describe(`Gemini model ID (default: ${config.model})`),
  thinkingLevel: z
    .enum(THINKING_LEVELS)
    .optional()
    .describe(
      `Reasoning depth (default: ${config.thinkingLevel}). Use high for multi-step questions about the content.`,
    ),
  mimeType: z
    .string()
    .optional()
    .describe('MIME type override; inferred from the file extension when omitted'),
};

const resolution = z
  .enum(MEDIA_RESOLUTIONS)
  .optional()
  .describe(
    `Tokens spent per image or video frame (default: ${config.mediaResolution}). ` +
      'Raise it to read small text or fine detail; lower it for long footage.',
  );

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

function generationConfig(thinkingLevel) {
  return { thinking_level: thinkingLevel || config.thinkingLevel };
}

function finalize(result, model, notes = []) {
  const lines = [result.text || '(empty response)'];
  if (result.status === 'incomplete') lines.push('\n[Output was truncated at the maximum output length.]');
  const footer = [usageLine(result.usage, model), ...notes.filter(Boolean)];
  lines.push(`\n---\n${footer.join('\n')}`);
  return success(lines.join('\n'));
}

// Accepts seconds (90 or "90"), "90s", "MM:SS" or "HH:MM:SS"; returns "90s".
function toDuration(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = String(value).trim();
  if (raw.includes(':')) {
    const parts = raw.split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n))) throw new Error(`Invalid timestamp "${raw}"`);
    const seconds = parts.reduce((acc, n) => acc * 60 + n, 0);
    return `${seconds}s`;
  }
  const seconds = parseOffset(raw);
  if (seconds === undefined) throw new Error(`Invalid timestamp "${raw}"`);
  return `${seconds}s`;
}

async function analyze({ kind, source, prompt, model, thinkingLevel, mimeType, decorate }) {
  const resolved = await resolveSource(kind, source, mimeType);
  try {
    const block = decorate ? decorate(resolved.block) : resolved.block;
    const modelId = model || config.model;
    const result = await runInteraction({
      model: modelId,
      input: [block, { type: 'text', text: prompt }],
      generation_config: generationConfig(thinkingLevel),
    });
    return finalize(result, modelId, [resolved.note]);
  } finally {
    await resolved.cleanup();
  }
}

export function registerMediaTools(server) {
  server.registerTool(
    'gemini_analyze_video',
    {
      title: 'Watch a video with Gemini',
      description:
        'Watch a video (frames and soundtrack together) with Gemini and answer a question about it. ' +
        'Use this whenever a task requires seeing or hearing what happens in a video file, a video URL ' +
        'or a public YouTube video. Ask for timestamps (MM:SS) in the prompt so follow-up questions can ' +
        'target specific moments. Agentic processing lets Gemini navigate long videos on demand; static ' +
        'processing samples frames at a fixed rate and is required for clipping (startOffset/endOffset) ' +
        'and custom fps.',
      inputSchema: {
        source: z.string().describe(`${SOURCE_DESCRIPTION}, or a public YouTube URL`),
        prompt: z
          .string()
          .default(
            'Describe what happens in this video, with MM:SS timestamps for each key moment, and summarize what is said.',
          )
          .describe('Question or instruction about the video'),
        processing: z
          .enum(['agentic', 'static'])
          .optional()
          .describe('agentic (default) or static. Clipping or fps force static.'),
        startOffset: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Clip start: seconds, "90s", "MM:SS" or "HH:MM:SS" (static processing)'),
        endOffset: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Clip end: seconds, "90s", "MM:SS" or "HH:MM:SS" (static processing)'),
        fps: z
          .number()
          .gt(0)
          .max(24)
          .optional()
          .describe('Frames sampled per second, up to 24 (static processing; default 1)'),
        resolution,
        ...common,
      },
      annotations: READ_ONLY,
    },
    async (
      {
        source,
        prompt,
        processing,
        startOffset,
        endOffset,
        fps,
        resolution: res,
        model,
        thinkingLevel,
        mimeType,
      },
      extra,
    ) =>
      withHeartbeat(extra, 'Gemini is watching the video', async () => {
        try {
          const start = toDuration(startOffset);
          const end = toDuration(endOffset);
          const needsStatic = start !== undefined || end !== undefined || fps !== undefined;
          if (processing === 'agentic' && needsStatic) {
            throw new Error('startOffset, endOffset and fps require processing "static"');
          }
          const mode = needsStatic ? 'static' : processing || 'agentic';

          return await analyze({
            kind: 'video',
            source,
            prompt,
            model,
            thinkingLevel,
            mimeType,
            decorate: (block) => {
              const decorated = { ...block, resolution: res || config.mediaResolution };
              if (mode === 'agentic') {
                decorated.processing = 'agentic';
              } else {
                const staticConfig = { type: 'static' };
                if (start !== undefined) staticConfig.start_offset = start;
                if (end !== undefined) staticConfig.end_offset = end;
                if (fps !== undefined) staticConfig.fps = fps;
                decorated.processing = staticConfig;
              }
              return decorated;
            },
          });
        } catch (e) {
          return failure(e);
        }
      }),
  );

  server.registerTool(
    'gemini_analyze_audio',
    {
      title: 'Listen to audio with Gemini',
      description:
        'Listen to an audio file with Gemini and answer a question about it: summarize, describe tone, ' +
        'music, sound events or speakers, or locate moments (prompts can reference MM:SS). ' +
        'Use this whenever a task requires hearing audio. For a verbatim transcript with speaker labels ' +
        'and word timestamps, use gemini_transcribe_audio instead.',
      inputSchema: {
        source: z.string().describe(SOURCE_DESCRIPTION),
        prompt: z
          .string()
          .default(
            'Describe this audio: what is said (summarized, with MM:SS timestamps), who speaks, and any notable sounds or music.',
          )
          .describe('Question or instruction about the audio'),
        ...common,
      },
      annotations: READ_ONLY,
    },
    async ({ source, prompt, model, thinkingLevel, mimeType }, extra) =>
      withHeartbeat(extra, 'Gemini is listening to the audio', async () => {
        try {
          return await analyze({ kind: 'audio', source, prompt, model, thinkingLevel, mimeType });
        } catch (e) {
          return failure(e);
        }
      }),
  );

  server.registerTool(
    'gemini_transcribe_audio',
    {
      title: 'Transcribe audio with Gemini',
      description:
        "Transcribe speech in an audio file with Gemini's dedicated transcription model. Returns the " +
        'transcript with speaker labels and MM:SS timestamps by default. Speaker labels or word ' +
        'timestamps limit the audio to 30 minutes; without them the limit is 1 hour. customVocabulary ' +
        'and smart mode cannot be combined with speaker labels or timestamps. For a video, extract the ' +
        'audio track first (for example with ffmpeg) or use gemini_analyze_video.',
      inputSchema: {
        source: z.string().describe(SOURCE_DESCRIPTION),
        languageCodes: z
          .array(z.string())
          .optional()
          .describe('BCP-47 language hints, e.g. ["es-PE", "en-US"]; auto-detected when omitted'),
        speakers: z.boolean().default(true).describe('Label speakers (diarization)'),
        wordTimestamps: z.boolean().default(true).describe('Include timestamps'),
        mode: z
          .enum(['verbatim', 'smart'])
          .default('verbatim')
          .describe('verbatim keeps every word; smart removes fillers and formats the text'),
        customVocabulary: z
          .array(z.string())
          .optional()
          .describe(
            'Names or terms to bias recognition toward (requires speakers=false and wordTimestamps=false)',
          ),
        model: z.string().optional().describe(`Transcription model ID (default: ${config.transcribeModel})`),
        mimeType: common.mimeType,
      },
      annotations: READ_ONLY,
    },
    async (
      { source, languageCodes, speakers, wordTimestamps, mode, customVocabulary, model, mimeType },
      extra,
    ) =>
      withHeartbeat(extra, 'Gemini is transcribing the audio', async () => {
        try {
          const hasVocabulary = customVocabulary?.length > 0;
          if ((mode === 'smart' || hasVocabulary) && (speakers || wordTimestamps)) {
            throw new Error(
              'smart mode and customVocabulary require speakers=false and wordTimestamps=false',
            );
          }

          const transcription = {};
          if (languageCodes?.length) transcription.language_codes = languageCodes;
          if (hasVocabulary) transcription.custom_vocabulary = customVocabulary;
          if (mode === 'smart') {
            transcription.mode = { type: 'smart' };
          } else {
            const verbatim = { type: 'verbatim' };
            if (speakers) verbatim.diarization_mode = 'speaker';
            if (wordTimestamps) verbatim.timestamp_granularities = ['word'];
            transcription.mode = verbatim;
          }

          const resolved = await resolveSource('audio', source, mimeType);
          try {
            const modelId = model || config.transcribeModel;
            const result = await runInteraction({
              model: modelId,
              input: [resolved.block],
              generation_config: { transcription_config: transcription },
            });
            const structured = formatWordTranscript(result.annotations);
            return finalize({ ...result, text: structured || result.text }, modelId, [resolved.note]);
          } finally {
            await resolved.cleanup();
          }
        } catch (e) {
          return failure(e);
        }
      }),
  );

  server.registerTool(
    'gemini_analyze_image',
    {
      title: 'Inspect an image with Gemini',
      description:
        'Ask Gemini about an image file or image URL. Useful for a second opinion, dense text, small ' +
        'details at high or ultra_high resolution, or images outside the current conversation.',
      inputSchema: {
        source: z.string().describe(SOURCE_DESCRIPTION),
        prompt: z
          .string()
          .default('Describe this image in detail.')
          .describe('Question or instruction about the image'),
        resolution,
        ...common,
      },
      annotations: READ_ONLY,
    },
    async ({ source, prompt, resolution: res, model, thinkingLevel, mimeType }, extra) =>
      withHeartbeat(extra, 'Gemini is inspecting the image', async () => {
        try {
          return await analyze({
            kind: 'image',
            source,
            prompt,
            model,
            thinkingLevel,
            mimeType,
            decorate: (block) => ({ ...block, resolution: res || config.mediaResolution }),
          });
        } catch (e) {
          return failure(e);
        }
      }),
  );

  server.registerTool(
    'gemini_analyze_document',
    {
      title: 'Read a document with Gemini',
      description:
        'Ask Gemini about a PDF or CSV, including scanned pages, charts and figures. Suited to large ' +
        'documents that would not fit in the current context.',
      inputSchema: {
        source: z.string().describe(SOURCE_DESCRIPTION),
        prompt: z
          .string()
          .default('Summarize this document.')
          .describe('Question or instruction about the document'),
        ...common,
      },
      annotations: READ_ONLY,
    },
    async ({ source, prompt, model, thinkingLevel, mimeType }, extra) =>
      withHeartbeat(extra, 'Gemini is reading the document', async () => {
        try {
          return await analyze({ kind: 'document', source, prompt, model, thinkingLevel, mimeType });
        } catch (e) {
          return failure(e);
        }
      }),
  );
}
