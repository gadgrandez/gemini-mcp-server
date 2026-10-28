import { z } from 'zod';
import { config, THINKING_LEVELS } from '../lib/config.js';
import { runInteraction, usageLine } from '../lib/run.js';
import { success, failure, withDeadline } from './result.js';

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Turns Google's search suggestion HTML snippets into plain links. Falls back
 * to Google Search links for the queries Gemini ran.
 */
export function suggestionLinks(snippets, queries) {
  const links = new Map();
  for (const html of snippets) {
    for (const match of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = decodeEntities(match[1]);
      const label = decodeEntities(match[2].replace(/<[^>]+>/g, ''))
        .replace(/\s+/g, ' ')
        .trim();
      if (href && label && !links.has(href)) links.set(href, label);
    }
  }
  if (links.size === 0) {
    for (const q of queries) links.set(`https://www.google.com/search?q=${encodeURIComponent(q)}`, q);
  }
  return [...links].map(([href, label]) => `- [${label}](${href})`);
}

function sourceLines(annotations) {
  const web = new Map();
  const places = new Map();
  for (const a of annotations) {
    if (a?.type === 'url_citation' && a.url && !web.has(a.url)) web.set(a.url, a.title || a.url);
    if (a?.type === 'place_citation' && a.url && !places.has(a.url)) places.set(a.url, a.name || a.url);
  }
  return {
    web: [...web].map(([url, title]) => `- [${title}](${url})`),
    places: [...places].map(([url, name]) => `- [${name}](${url}) (Google Maps)`),
  };
}

export function registerSearchTools(server) {
  server.registerTool(
    'gemini_search',
    {
      title: 'Search with Google through Gemini',
      description:
        "Answer a question with Gemini grounded on Google Search, returning the answer, its sources and Google's " +
        'search suggestions. Use it to cross-check results from your own web search, or when that search ' +
        'returns thin or outdated results, especially for local (for example Peruvian), Spanish-language or very ' +
        'recent topics. Set maps=true for places, businesses, addresses or routes, with optional coordinates to ' +
        'bias results. Each call can run several billable Google searches. Show the answer to the user together ' +
        'with its sources and search suggestions, without altering the grounded answer.',
      inputSchema: {
        query: z.string().describe('The question to answer, phrased as the user would search for it'),
        maps: z
          .boolean()
          .default(false)
          .describe('Also ground on Google Maps for places and local businesses'),
        latitude: z
          .number()
          .min(-90)
          .max(90)
          .optional()
          .describe('Latitude to bias Maps results (with maps=true)'),
        longitude: z
          .number()
          .min(-180)
          .max(180)
          .optional()
          .describe('Longitude to bias Maps results (with maps=true)'),
        model: z.string().optional().describe(`Gemini model ID (default: ${config.model})`),
        thinkingLevel: z
          .enum(THINKING_LEVELS)
          .optional()
          .describe(`Reasoning depth (default: ${config.thinkingLevel})`),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ query, maps, latitude, longitude, model, thinkingLevel }, extra) =>
      withDeadline(extra, 'Gemini is searching Google', async () => {
        try {
          if ((latitude === undefined) !== (longitude === undefined)) {
            throw new Error('Pass latitude and longitude together');
          }
          if (latitude !== undefined && !maps) throw new Error('latitude and longitude require maps=true');

          const tools = [{ type: 'google_search' }];
          if (maps) {
            const mapsTool = { type: 'google_maps' };
            if (latitude !== undefined) {
              mapsTool.latitude = latitude;
              mapsTool.longitude = longitude;
            }
            tools.push(mapsTool);
          }

          const modelId = model || config.model;
          const result = await runInteraction({
            model: modelId,
            input: [{ type: 'text', text: query }],
            tools,
            generation_config: { thinking_level: thinkingLevel || config.thinkingLevel },
          });

          const { web, places } = sourceLines(result.annotations);
          const suggestions = suggestionLinks(result.searchSuggestions, result.searchQueries);
          const sections = [result.text || '(empty response)'];
          if (places.length) sections.push(`Google Maps sources:\n${places.join('\n')}`);
          if (web.length) sections.push(`Sources:\n${web.join('\n')}`);
          if (suggestions.length) sections.push(`Google Search suggestions:\n${suggestions.join('\n')}`);
          if (!web.length && !places.length) {
            sections.push('[Gemini answered without citing Google results; treat the answer as ungrounded.]');
          }
          const footer = [usageLine(result.usage, modelId)];
          if (result.searchQueries.length) footer.push(`searches run: ${result.searchQueries.length}`);
          return success(`${sections.join('\n\n')}\n\n---\n${footer.join('\n')}`);
        } catch (e) {
          return failure(e);
        }
      }),
  );
}
