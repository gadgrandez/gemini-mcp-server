import { ai, config } from './config.js';

const FAILED_STATUSES = new Set(['failed', 'cancelled', 'budget_exceeded']);

/**
 * Runs a model interaction with streaming enabled and returns the collected
 * output. Streaming keeps the connection active during long media processing
 * without requiring server-side storage, so it works with store=false.
 */
export async function runInteraction(params) {
  const request = { store: config.store, ...params, stream: true };
  const stream = await ai.interactions.create(request, { timeout_ms: config.timeoutMs });

  const stepTypes = new Map();
  const text = [];
  const annotations = [];
  const searchQueries = [];
  const searchSuggestions = [];
  let status;
  let usage;

  for await (const event of stream) {
    switch (event.event_type) {
      case 'step.start':
        stepTypes.set(event.index, event.step?.type);
        collectToolStep(event.step, searchQueries, searchSuggestions);
        if (event.step?.type === 'model_output') {
          for (const block of event.step.content || []) {
            if (block.type === 'text' && block.text) text.push(block.text);
            if (block.annotations) annotations.push(...block.annotations);
          }
        }
        break;
      case 'step.delta': {
        collectToolStep(event.delta, searchQueries, searchSuggestions);
        if (stepTypes.get(event.index) !== 'model_output') break;
        const delta = event.delta;
        if (delta?.type === 'text' && delta.text) text.push(delta.text);
        if (delta?.type === 'text_annotation_delta' && delta.annotations)
          annotations.push(...delta.annotations);
        if (event.metadata?.total_usage) usage = event.metadata.total_usage;
        break;
      }
      case 'step.stop':
        if (event.usage) usage = event.usage;
        break;
      case 'interaction.status_update':
        status = event.status;
        break;
      case 'interaction.completed':
        status = event.interaction?.status || status || 'completed';
        if (event.interaction?.usage) usage = event.interaction.usage;
        break;
      case 'error':
        throw new Error(
          `Gemini error${event.error?.code ? ` (${event.error.code})` : ''}: ${event.error?.message || 'unknown error'}`,
        );
      default:
        break;
    }
  }

  if (status && FAILED_STATUSES.has(status)) {
    throw new Error(`Gemini interaction ended with status "${status}"`);
  }

  return {
    text: text.join(''),
    annotations,
    searchQueries: [...new Set(searchQueries)],
    searchSuggestions,
    status: status || 'completed',
    usage,
  };
}

// Search and Maps tool steps carry the queries Gemini ran and Google's
// search suggestion snippet, which grounded answers must be shown with.
function collectToolStep(step, queries, suggestions) {
  if (!step) return;
  if (step.type === 'google_search_call' || step.type === 'google_maps_call') {
    for (const q of step.arguments?.queries || []) if (q) queries.push(q);
  }
  if (step.type === 'google_search_result') {
    for (const r of step.result || []) if (r?.search_suggestions) suggestions.push(r.search_suggestions);
  }
}

export function usageLine(usage, model) {
  if (!usage) return `model: ${model}`;
  const parts = [`model: ${model}`];
  if (usage.total_input_tokens !== undefined) parts.push(`input tokens: ${usage.total_input_tokens}`);
  if (usage.total_output_tokens !== undefined) parts.push(`output tokens: ${usage.total_output_tokens}`);
  if (usage.total_thought_tokens) parts.push(`thinking tokens: ${usage.total_thought_tokens}`);
  return parts.join(' | ');
}
