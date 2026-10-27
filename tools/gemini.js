import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { ai, config, THINKING_LEVELS } from '../lib/config.js';
import { kindOf, resolveSource, toPart } from '../lib/sources.js';
import { runInteraction, usageLine } from '../lib/run.js';
import { success, failure, withDeadline } from './result.js';

const SOURCES_DESCRIPTION =
  'Absolute local paths, Files API names (files/...), https:// URLs or gs:// URIs; the kind ' +
  '(video, audio, image, document) is inferred from the extension';

// gemini-embedding-2 accepts these formats only.
const EMBEDDING_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/mov',
  pdf: 'application/pdf',
};

function inferKind(source) {
  if (/^files\//.test(source)) return undefined;
  const kind = kindOf(source);
  if (!kind) throw new Error(`Cannot infer the media kind of "${source}" from its extension`);
  return kind;
}

async function resolveMany(sources, options) {
  const resolved = [];
  try {
    for (const source of sources) {
      const kind = inferKind(source) || 'document';
      resolved.push(await resolveSource(kind, source, undefined, options));
    }
    return resolved;
  } catch (e) {
    await Promise.all(resolved.map((r) => r.cleanup()));
    throw e;
  }
}

function absoluteOutput(path) {
  if (!isAbsolute(path)) throw new Error('outputPath must be an absolute path');
  return resolve(path);
}

export function registerGeminiTools(server) {
  server.registerTool(
    'gemini_chat',
    {
      title: 'Ask Gemini for a second opinion',
      description:
        'Send a prompt to a Gemini model and return its answer. Use it to get an independent ' +
        "model's view: a second opinion on a decision, a review of a draft or code, or a check " +
        'of a conclusion. Optional sources add files as context.',
      inputSchema: {
        prompt: z.string().describe('The question or instruction for Gemini'),
        sources: z
          .array(z.string())
          .optional()
          .describe(`Files to include as context. ${SOURCES_DESCRIPTION}`),
        systemInstruction: z.string().optional().describe('System instruction for Gemini'),
        model: z.string().optional().describe(`Gemini model ID (default: ${config.model})`),
        thinkingLevel: z
          .enum(THINKING_LEVELS)
          .optional()
          .describe(`Reasoning depth (default: ${config.thinkingLevel})`),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ prompt, sources, systemInstruction, model, thinkingLevel }, extra) =>
      withDeadline(extra, 'Waiting for Gemini', async () => {
        let resolved = [];
        try {
          resolved = await resolveMany(sources || []);
          const modelId = model || config.model;
          const request = {
            model: modelId,
            input: [...resolved.map((r) => r.block), { type: 'text', text: prompt }],
            generation_config: { thinking_level: thinkingLevel || config.thinkingLevel },
          };
          if (systemInstruction) request.system_instruction = systemInstruction;
          const result = await runInteraction(request);
          const footer = [usageLine(result.usage, modelId), ...resolved.map((r) => r.note).filter(Boolean)];
          const truncated =
            result.status === 'incomplete' ? '\n[Output was truncated at the maximum output length.]' : '';
          return success(`${result.text || '(empty response)'}${truncated}\n\n---\n${footer.join('\n')}`);
        } catch (e) {
          return failure(e);
        } finally {
          await Promise.all(resolved.map((r) => r.cleanup()));
        }
      }),
  );

  server.registerTool(
    'gemini_list_models',
    {
      title: 'List Gemini models',
      description:
        'List the Gemini models available to this API key, with their input and output token limits. ' +
        'Use it to find current model IDs, since Google releases and retires models often.',
      inputSchema: {
        filter: z.string().optional().describe('Only list models whose ID or name contains this text'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ filter }) => {
      try {
        const needle = filter?.toLowerCase();
        const rows = [];
        const pager = await ai.models.list({ config: { pageSize: 100 } });
        for await (const m of pager) {
          const haystack = `${m.name} ${m.displayName || ''}`.toLowerCase();
          if (needle && !haystack.includes(needle)) continue;
          rows.push(
            [
              `${m.name?.replace(/^models\//, '')}${m.displayName ? ` (${m.displayName})` : ''}`,
              `  input tokens: ${m.inputTokenLimit ?? 'N/A'} | output tokens: ${m.outputTokenLimit ?? 'N/A'}`,
              m.supportedActions?.length ? `  actions: ${m.supportedActions.join(', ')}` : undefined,
            ]
              .filter(Boolean)
              .join('\n'),
          );
        }
        if (rows.length === 0) return success(filter ? `No models match "${filter}".` : 'No models found.');
        return success(`Gemini models (${rows.length}):\n\n${rows.join('\n\n')}`);
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'gemini_count_tokens',
    {
      title: 'Count Gemini tokens',
      description:
        "Count the input tokens a prompt and files would use with a Gemini model's tokenizer, to " +
        'estimate the cost of a large video, audio or document before analyzing it. The count ' +
        'reflects static processing; agentic video processing usually uses fewer tokens.',
      inputSchema: {
        prompt: z.string().optional().describe('Text to include in the count'),
        sources: z.array(z.string()).optional().describe(`Files to include. ${SOURCES_DESCRIPTION}`),
        model: z.string().optional().describe(`Gemini model ID (default: ${config.model})`),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ prompt, sources, model }, extra) =>
      withDeadline(extra, 'Counting tokens', async () => {
        let resolved = [];
        try {
          if (!prompt && !sources?.length) throw new Error('Provide a prompt, sources, or both');
          resolved = await resolveMany(sources || []);
          const parts = resolved.map((r) => toPart(r.block));
          if (prompt) parts.push({ text: prompt });
          const modelId = model || config.model;
          const result = await ai.models.countTokens({
            model: modelId,
            contents: [{ role: 'user', parts }],
          });
          return success(`Input tokens (model: ${modelId}): ${result.totalTokens}`);
        } catch (e) {
          return failure(e);
        } finally {
          await Promise.all(resolved.map((r) => r.cleanup()));
        }
      }),
  );

  server.registerTool(
    'gemini_embed',
    {
      title: 'Create Gemini embeddings',
      description:
        'Create embedding vectors with gemini-embedding-2 for text, images (PNG, JPEG), audio (MP3, ' +
        'WAV, up to 180 s), video (MP4, MOV, up to 120 s) and PDFs (up to 6 pages), all in one vector ' +
        'space for semantic search, clustering or similarity. "separate" returns one vector per item; ' +
        '"aggregate" returns a single vector for all items together. Pass outputPath to save the full ' +
        'vectors as JSON; otherwise only a preview is returned.',
      inputSchema: {
        texts: z.array(z.string()).optional().describe('Text items'),
        sources: z
          .array(z.string())
          .optional()
          .describe('Media items: absolute local paths, files/... names, https:// URLs or gs:// URIs'),
        mode: z
          .enum(['separate', 'aggregate'])
          .default('separate')
          .describe('One vector per item, or one for all'),
        dimensions: z
          .number()
          .int()
          .min(128)
          .max(3072)
          .optional()
          .describe('Output dimensions, 128 to 3072 (default 3072; 768 and 1536 recommended)'),
        outputPath: z
          .string()
          .optional()
          .describe('Absolute path of a JSON file to write the full vectors to'),
        model: z.string().optional().describe(`Embedding model ID (default: ${config.embeddingModel})`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ texts, sources, mode, dimensions, outputPath, model }, extra) =>
      withDeadline(extra, 'Creating embeddings', async () => {
        const resolved = [];
        try {
          const textItems = texts || [];
          const mediaItems = sources || [];
          if (textItems.length + mediaItems.length === 0) throw new Error('Provide texts, sources, or both');
          const target = outputPath ? absoluteOutput(outputPath) : undefined;

          for (const source of mediaItems) {
            const ext = source.split(/[?#]/)[0].split('.').pop().toLowerCase();
            const mime = /^files\//.test(source) ? undefined : EMBEDDING_MIME[ext];
            if (!/^files\//.test(source) && !mime) {
              throw new Error(
                `"${source}" is not a format gemini-embedding-2 accepts (${Object.keys(EMBEDDING_MIME).join(', ')})`,
              );
            }
            const kind = /^files\//.test(source) ? 'document' : kindOf(source);
            resolved.push(await resolveSource(kind, source, mime));
          }

          const textParts = textItems.map((text) => ({ text }));
          const mediaParts = resolved.map((r) => toPart(r.block));
          const allParts = [...textParts, ...mediaParts];
          const labels = [...textItems.map((t) => `text: ${t.slice(0, 60)}`), ...mediaItems];

          const contents = mode === 'aggregate' ? allParts : allParts.map((part) => ({ parts: [part] }));
          const modelId = model || config.embeddingModel;
          const response = await ai.models.embedContent({
            model: modelId,
            contents,
            config: dimensions ? { outputDimensionality: dimensions } : undefined,
          });
          const vectors = (response.embeddings || []).map((e) => e.values || []);
          if (vectors.length === 0) throw new Error('Gemini returned no embeddings');

          const items =
            mode === 'aggregate'
              ? [{ input: labels.join(' + '), values: vectors[0] }]
              : vectors.map((values, i) => ({ input: labels[i], values }));

          let saved = '';
          if (target) {
            await mkdir(dirname(target), { recursive: true });
            await writeFile(
              target,
              JSON.stringify({ model: modelId, mode, dimensions: items[0].values.length, items }, null, 2),
            );
            saved = `\nSaved full vectors to ${target}`;
          }

          const preview = items
            .map(
              (item) =>
                `- ${item.input}\n  [${item.values
                  .slice(0, 6)
                  .map((v) => v.toFixed(5))
                  .join(', ')}, …]`,
            )
            .join('\n');
          return success(
            `${items.length} embedding(s), ${items[0].values.length} dimensions (model: ${modelId}):\n${preview}${saved}`,
          );
        } catch (e) {
          return failure(e);
        } finally {
          await Promise.all(resolved.map((r) => r.cleanup()));
        }
      }),
  );
}
