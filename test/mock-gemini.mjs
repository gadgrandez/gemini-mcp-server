// Minimal stand-in for the Gemini API used by the test suite. It records every
// request and answers the endpoints the server calls: Interactions (SSE) and
// the Files API (resumable upload, get, list, delete).
import { createServer } from 'node:http';

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) {
    res.write(`event: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function interactionEvents(body) {
  const id = 'int_test_1';
  const created = { event_type: 'interaction.created', interaction: { id, status: 'in_progress' } };
  const completed = {
    event_type: 'interaction.completed',
    interaction: {
      id,
      status: 'completed',
      usage: { total_input_tokens: 1200, total_output_tokens: 42, total_thought_tokens: 7 },
    },
  };

  if (String(body.model).includes('transcribe')) {
    return [
      created,
      { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'Hola Flavio. Buenos días.' } },
      {
        event_type: 'step.delta',
        index: 0,
        delta: {
          type: 'text_annotation_delta',
          annotations: [
            { type: 'word_info', text: 'Hola', speaker: 'spk_1', start_offset: '0.4s', end_offset: '0.8s' },
            { type: 'word_info', text: 'Flavio', speaker: 'spk_1', start_offset: '0.8s', end_offset: '1.2s' },
            { type: 'word_info', text: '.', speaker: 'spk_1', start_offset: '1.2s', end_offset: '1.2s' },
            {
              type: 'word_info',
              text: 'Buenos',
              speaker: 'spk_2',
              start_offset: '65.0s',
              end_offset: '65.4s',
            },
            { type: 'word_info', text: 'días', speaker: 'spk_2', start_offset: '65.4s', end_offset: '65.9s' },
          ],
        },
      },
      { event_type: 'step.stop', index: 0 },
      completed,
    ];
  }

  return [
    created,
    { event_type: 'step.start', index: 0, step: { type: 'thought' } },
    {
      event_type: 'step.delta',
      index: 0,
      delta: { type: 'thought_summary', content: { type: 'text', text: 'private reasoning' } },
    },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'step.start', index: 1, step: { type: 'model_output', content: [] } },
    { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'A cat jumps ' } },
    { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'onto a table at 00:12.' } },
    { event_type: 'step.stop', index: 1 },
    completed,
  ];
}

export async function startMockGemini() {
  const requests = [];
  const files = new Map();
  const research = new Map();
  let counter = 0;

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://localhost');
    let body;
    const isJson = (req.headers['content-type'] || '').includes('json');
    if (isJson && raw.length) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        body = undefined; // binary upload chunk sent with a JSON content type
      }
    }
    requests.push({ method: req.method, path: url.pathname, headers: req.headers, body, bytes: raw.length });

    const port = server.address().port;

    if (req.method === 'POST' && /\/v1beta\/interactions$/.test(url.pathname) && body?.agent) {
      research.set('res_1', { polls: 0 });
      return json(res, 200, { id: 'res_1', status: 'in_progress', agent: body.agent });
    }

    const researchMatch = url.pathname.match(/^\/v1beta\/interactions\/([\w-]+)$/);
    if (researchMatch && req.method === 'GET') {
      const state = research.get(researchMatch[1]);
      if (!state) return json(res, 404, { error: { code: 404, message: 'not found' } });
      state.polls += 1;
      if (state.polls < 3) return json(res, 200, { id: researchMatch[1], status: 'in_progress' });
      return json(res, 200, {
        id: researchMatch[1],
        status: 'completed',
        steps: [
          { type: 'user_input', content: [{ type: 'text', text: 'question' }] },
          { type: 'thought', summary: [] },
          {
            type: 'model_output',
            content: [
              {
                type: 'text',
                text: '# TPU history\n\nGoogle announced the first TPU in 2016.',
                annotations: [
                  { type: 'url_citation', url: 'https://example.com/tpu', title: 'TPU paper' },
                  { type: 'url_citation', url: 'https://example.com/tpu', title: 'TPU paper' },
                ],
              },
            ],
          },
        ],
      });
    }

    if (req.method === 'GET' && url.pathname === '/v1beta/models') {
      return json(res, 200, {
        models: [
          {
            name: 'models/gemini-3.8-flash',
            displayName: 'Gemini 3.8 Flash',
            inputTokenLimit: 1048576,
            outputTokenLimit: 65536,
            supportedActions: ['generateContent', 'countTokens'],
          },
          {
            name: 'models/gemini-embedding-2',
            displayName: 'Gemini Embedding 2',
            inputTokenLimit: 8192,
            outputTokenLimit: 1,
            supportedActions: ['embedContent'],
          },
        ],
      });
    }

    if (req.method === 'POST' && /:countTokens$/.test(url.pathname)) {
      return json(res, 200, { totalTokens: 4321 });
    }

    if (req.method === 'POST' && /:batchEmbedContents$/.test(url.pathname)) {
      const n = body?.requests?.length || 1;
      const dims = body?.requests?.[0]?.outputDimensionality || 3072;
      return json(res, 200, {
        embeddings: Array.from({ length: n }, (_, i) => ({
          values: Array.from({ length: dims }, (_, j) => (i + 1) / (j + 1)),
        })),
      });
    }
    if (req.method === 'POST' && /:embedContent$/.test(url.pathname)) {
      const dims = body?.outputDimensionality || 3072;
      return json(res, 200, { embedding: { values: Array.from({ length: dims }, (_, j) => 1 / (j + 1)) } });
    }

    if (req.method === 'POST' && /\/v1beta\/interactions$/.test(url.pathname)) {
      const slow = JSON.stringify(body?.input || []).includes('SLOW');
      if (slow) await new Promise((r) => setTimeout(r, 1500));
      return sse(res, interactionEvents(body || {}));
    }

    if (req.method === 'POST' && url.pathname === '/upload/v1beta/files') {
      counter += 1;
      const name = `files/mock${counter}`;
      files.set(name, {
        name,
        displayName: body?.file?.displayName,
        mimeType: body?.file?.mimeType || req.headers['x-goog-upload-header-content-type'],
        uri: `https://generativelanguage.googleapis.com/v1beta/${name}`,
        sizeBytes: String(req.headers['x-goog-upload-header-content-length'] || 0),
        state: 'PROCESSING',
      });
      return json(
        res,
        200,
        {},
        {
          'x-goog-upload-url': `http://127.0.0.1:${port}/upload-session/${name}`,
          'x-goog-upload-status': 'active',
        },
      );
    }

    if (req.method === 'POST' && url.pathname.startsWith('/upload-session/')) {
      const name = url.pathname.replace('/upload-session/', '');
      const file = files.get(name);
      return json(res, 200, { file }, { 'x-goog-upload-status': 'final' });
    }

    const fileMatch = url.pathname.match(/^\/v1beta\/(files\/[\w-]+)$/);
    if (fileMatch && req.method === 'GET') {
      const file = files.get(fileMatch[1]);
      if (!file) return json(res, 404, { error: { code: 404, message: 'not found', status: 'NOT_FOUND' } });
      file.state = 'ACTIVE';
      return json(res, 200, file);
    }
    if (fileMatch && req.method === 'DELETE') {
      files.delete(fileMatch[1]);
      return json(res, 200, {});
    }
    if (req.method === 'GET' && url.pathname === '/v1beta/files') {
      return json(res, 200, { files: [...files.values()] });
    }

    json(res, 404, { error: { code: 404, message: `unhandled ${req.method} ${url.pathname}` } });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    files,
    close: () => new Promise((r) => server.close(r)),
  };
}
