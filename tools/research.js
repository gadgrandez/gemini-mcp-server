import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { ai, config } from '../lib/config.js';
import { kindOf, resolveSource } from '../lib/sources.js';
import { success, failure, withHeartbeat } from './result.js';

const POLL_MS = Number.parseInt(process.env.GEMINI_RESEARCH_POLL_MS || '', 10) || 10_000;
const DONE = new Set(['completed', 'incomplete']);
const FAILED = new Set(['failed', 'cancelled', 'budget_exceeded']);

function reportText(interaction) {
  const outputs = (interaction.steps || []).filter((s) => s.type === 'model_output');
  const last = outputs.at(-1);
  const blocks = last?.content || [];
  const text = blocks
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n');
  const citations = new Map();
  for (const block of blocks) {
    for (const a of block.annotations || []) {
      if (a.type === 'url_citation' && a.url && !citations.has(a.url)) citations.set(a.url, a.title || a.url);
    }
  }
  let report = text || interaction.output_text || '';
  if (citations.size > 0 && !/\n#+\s*(sources|references)\b/i.test(report)) {
    report += `\n\n## Sources\n${[...citations].map(([url, title]) => `- [${title}](${url})`).join('\n')}`;
  }
  return report;
}

async function finish(interaction, outputPath) {
  const report = reportText(interaction);
  if (!report) throw new Error(`Research ${interaction.id} completed without a report`);
  let saved = '';
  if (outputPath) {
    if (!isAbsolute(outputPath)) throw new Error('outputPath must be an absolute path');
    const target = resolve(outputPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, report, 'utf8');
    saved = `\n\nSaved report to ${target}`;
  }
  const truncated = interaction.status === 'incomplete' ? '\n\n[Report was truncated.]' : '';
  return success(`Deep research complete (interaction ${interaction.id}).\n\n${report}${truncated}${saved}`);
}

async function pollUntil(id, deadline) {
  let interaction = await ai.interactions.get(id);
  while (!DONE.has(interaction.status) && !FAILED.has(interaction.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))));
    interaction = await ai.interactions.get(id);
  }
  return interaction;
}

function pending(interaction) {
  return success(
    `Deep research is still running (status: ${interaction.status}).\n` +
      `Interaction ID: ${interaction.id}\n\n` +
      'Call gemini_check_research with this ID and waitMinutes to collect the report.',
  );
}

function failed(interaction) {
  const detail = interaction.error?.message || JSON.stringify(interaction.error || {});
  throw new Error(`Deep research ${interaction.status}${detail && detail !== '{}' ? `: ${detail}` : ''}`);
}

export function registerResearchTools(server) {
  server.registerTool(
    'gemini_deep_research',
    {
      title: 'Start Gemini Deep Research',
      description:
        'Start a Gemini Deep Research task: an agent that plans, runs many Google searches, reads ' +
        'sources and writes a cited report. It takes several minutes. This tool waits up to ' +
        'waitSeconds and returns the report if it finishes; otherwise it returns an interaction ID ' +
        'for gemini_check_research. Deep Research runs in the background on Google, which requires ' +
        'storing the interaction there regardless of GEMINI_STORE.',
      inputSchema: {
        query: z
          .string()
          .describe('The research question, with scope, audience and anything to include or avoid'),
        depth: z
          .enum(['standard', 'max'])
          .default('standard')
          .describe('standard is faster; max gathers more sources and is more thorough'),
        documents: z
          .array(z.string())
          .optional()
          .describe(
            'PDFs or images to research alongside the web: absolute local paths, files/... names, https:// URLs or gs:// URIs',
          ),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .default(60)
          .describe('How long to wait for the report before returning the interaction ID'),
        outputPath: z.string().optional().describe('Absolute path of a Markdown file to save the report to'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ query, depth, documents, waitSeconds, outputPath }, extra) =>
      withHeartbeat(extra, 'Gemini Deep Research is running', async () => {
        try {
          const input = [];
          for (const source of documents || []) {
            const kind = /^files\//.test(source) ? 'document' : kindOf(source);
            if (kind !== 'document' && kind !== 'image') {
              throw new Error(`Deep Research accepts PDFs and images as documents; got "${source}"`);
            }
            // Uploads must outlive this call because the research runs asynchronously.
            const { block } = await resolveSource(kind, source, undefined, { keepUpload: true });
            input.push(block);
          }
          input.push({ type: 'text', text: query });

          const agent = depth === 'max' ? config.researchMaxAgent : config.researchAgent;
          const created = await ai.interactions.create({
            agent,
            input,
            background: true,
            store: true,
            agent_config: {
              type: 'deep-research',
              thinking_summaries: 'none',
              collaborative_planning: false,
            },
          });
          if (!created?.id) throw new Error('Deep research started without an interaction ID');

          const interaction = await pollUntil(created.id, Date.now() + waitSeconds * 1000);
          if (FAILED.has(interaction.status)) failed(interaction);
          if (DONE.has(interaction.status)) return await finish(interaction, outputPath);
          return pending(interaction);
        } catch (e) {
          return failure(e);
        }
      }),
  );

  server.registerTool(
    'gemini_check_research',
    {
      title: 'Check Gemini Deep Research',
      description:
        'Check a Deep Research task started with gemini_deep_research and return the report when it ' +
        'is ready. waitMinutes keeps polling up to that long before returning.',
      inputSchema: {
        interactionId: z.string().describe('Interaction ID returned by gemini_deep_research'),
        waitMinutes: z
          .number()
          .min(0)
          .max(30)
          .default(0)
          .describe('Minutes to keep waiting (0 = check once)'),
        outputPath: z.string().optional().describe('Absolute path of a Markdown file to save the report to'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ interactionId, waitMinutes, outputPath }, extra) =>
      withHeartbeat(extra, 'Waiting for Gemini Deep Research', async () => {
        try {
          const interaction = await pollUntil(interactionId, Date.now() + waitMinutes * 60_000);
          if (FAILED.has(interaction.status)) failed(interaction);
          if (DONE.has(interaction.status)) return await finish(interaction, outputPath);
          return pending(interaction);
        } catch (e) {
          return failure(e);
        }
      }),
  );
}
