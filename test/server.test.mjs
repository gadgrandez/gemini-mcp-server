import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startMockGemini } from './mock-gemini.mjs';

const serverPath = fileURLToPath(new URL('../index.js', import.meta.url));

let mock;
let client;
let shortClient;
let dir;

function lastInteraction() {
  const hits = mock.requests.filter((r) => r.path.endsWith('/interactions'));
  return hits.at(-1);
}

// Polls gemini_job_status the way a client would until the job stops reporting progress.
async function collectJob(c, jobId) {
  for (let i = 0; i < 20; i++) {
    const r = await c.callTool({ name: 'gemini_job_status', arguments: { jobId } });
    if (!/^Still running after/.test(textOf(r))) return r;
  }
  throw new Error(`Job ${jobId} did not finish`);
}

function textOf(result) {
  return result.content.map((c) => c.text).join('\n');
}

before(async () => {
  mock = await startMockGemini();
  dir = await mkdtemp(join(tmpdir(), 'gemini-mcp-test-'));
  await writeFile(join(dir, 'small.mp4'), Buffer.alloc(1024, 1));
  await writeFile(join(dir, 'large.mp4'), Buffer.alloc(2 * 1024 * 1024, 2));
  await writeFile(join(dir, 'voice.m4a'), Buffer.alloc(2048, 3));
  await writeFile(join(dir, 'photo.png'), Buffer.alloc(512, 4));
  await writeFile(join(dir, 'report.pdf'), Buffer.alloc(512, 5));
  await writeFile(join(dir, 'clip.mkv'), Buffer.alloc(512, 6));
  await writeFile(join(dir, 'song.ogg'), Buffer.alloc(512, 7));
  await writeFile(join(dir, 'big.pdf'), Buffer.alloc(2 * 1024 * 1024, 8));

  client = await connectClient({});
  // A one-second call window exercises the background job path.
  shortClient = await connectClient({ GEMINI_SYNC_WAIT_SECONDS: '1' });
});

async function connectClient(extraEnv) {
  const c = new Client({ name: 'test-client', version: '1.0.0' });
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: {
        PATH: process.env.PATH,
        GEMINI_API_KEY: 'test-key',
        GEMINI_BASE_URL: mock.url,
        GEMINI_INLINE_MAX_MB: '1',
        GEMINI_PROGRESS_INTERVAL_MS: '200',
        GEMINI_RESEARCH_POLL_MS: '50',
        ...extraEnv,
      },
      stderr: 'inherit',
    }),
  );
  return c;
}

after(async () => {
  await client?.close();
  await shortClient?.close();
  await mock?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('exposes the expected tools', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'gemini_analyze_audio',
    'gemini_analyze_document',
    'gemini_analyze_image',
    'gemini_analyze_video',
    'gemini_chat',
    'gemini_check_research',
    'gemini_count_tokens',
    'gemini_deep_research',
    'gemini_delete_file',
    'gemini_embed',
    'gemini_job_status',
    'gemini_list_files',
    'gemini_list_models',
    'gemini_search',
    'gemini_transcribe_audio',
    'gemini_upload_file',
  ]);
  const video = tools.find((t) => t.name === 'gemini_analyze_video');
  assert.equal(video.annotations.readOnlyHint, true);
  assert.deepEqual(video.inputSchema.required, ['source']);
});

test('video: small file is sent inline with agentic processing and store=false', async () => {
  const result = await client.callTool({
    name: 'gemini_analyze_video',
    arguments: { source: join(dir, 'small.mp4'), prompt: 'What happens?' },
  });
  assert.equal(result.isError, undefined, textOf(result));
  const text = textOf(result);
  assert.match(text, /A cat jumps onto a table at 00:12\./);
  assert.doesNotMatch(text, /private reasoning/);
  assert.match(
    text,
    /model: gemini-3\.8-flash \| input tokens: 1200 \| output tokens: 42 \| thinking tokens: 7/,
  );

  const req = lastInteraction();
  assert.equal(req.headers['x-goog-api-key'], 'test-key');
  assert.equal(req.body.model, 'gemini-3.8-flash');
  assert.equal(req.body.stream, true);
  assert.equal(req.body.store, false);
  assert.deepEqual(req.body.generation_config, { thinking_level: 'low' });
  const [media, prompt] = req.body.input;
  assert.equal(media.type, 'video');
  assert.equal(media.mime_type, 'video/mp4');
  assert.equal(media.processing, 'agentic');
  assert.equal(media.resolution, 'medium');
  assert.equal(media.data, Buffer.alloc(1024, 1).toString('base64'));
  assert.deepEqual(prompt, { type: 'text', text: 'What happens?' });
});

test('video: clipping switches to static processing with duration strings', async () => {
  const result = await client.callTool({
    name: 'gemini_analyze_video',
    arguments: {
      source: join(dir, 'small.mp4'),
      startOffset: '01:30',
      endOffset: 120,
      fps: 0.5,
      resolution: 'high',
      thinkingLevel: 'high',
      model: 'gemini-4-argon',
    },
  });
  assert.equal(result.isError, undefined, textOf(result));
  const req = lastInteraction();
  assert.equal(req.body.model, 'gemini-4-argon');
  assert.deepEqual(req.body.generation_config, { thinking_level: 'high' });
  assert.deepEqual(req.body.input[0].processing, {
    type: 'static',
    start_offset: '90s',
    end_offset: '120s',
    fps: 0.5,
  });
  assert.equal(req.body.input[0].resolution, 'high');
  assert.match(req.body.input[1].text, /MM:SS timestamps/);
});

test('video: agentic plus clipping is rejected', async () => {
  const result = await client.callTool({
    name: 'gemini_analyze_video',
    arguments: { source: join(dir, 'small.mp4'), processing: 'agentic', fps: 2 },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /require processing "static"/);
});

test('video: YouTube URL is passed by reference', async () => {
  const url = 'https://www.youtube.com/watch?v=abc123';
  const result = await client.callTool({ name: 'gemini_analyze_video', arguments: { source: url } });
  assert.equal(result.isError, undefined, textOf(result));
  const media = lastInteraction().body.input[0];
  assert.equal(media.uri, url);
  assert.equal(media.data, undefined);
  assert.equal(media.mime_type, undefined);
});

test('video: large file goes through the Files API and is deleted afterwards', async () => {
  const before = mock.requests.length;
  const result = await client.callTool({
    name: 'gemini_analyze_video',
    arguments: { source: join(dir, 'large.mp4') },
  });
  assert.equal(result.isError, undefined, textOf(result));
  const calls = mock.requests.slice(before).map((r) => `${r.method} ${r.path}`);
  assert.ok(calls.includes('POST /upload/v1beta/files'), calls.join('\n'));
  const media = lastInteraction().body.input[0];
  assert.match(media.uri, /\/v1beta\/files\/mock\d+$/);
  assert.equal(media.mime_type, 'video/mp4');
  assert.ok(
    calls.some((c) => /^DELETE \/v1beta\/files\/mock\d+$/.test(c)),
    calls.join('\n'),
  );
  assert.equal(mock.files.size, 0);
});

test('video: unsupported container gives an actionable error', async () => {
  const result = await client.callTool({
    name: 'gemini_analyze_video',
    arguments: { source: join(dir, 'clip.mkv') },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Supported extensions: .*mp4.*ffmpeg/s);
});

test('relative paths are rejected', async () => {
  const result = await client.callTool({ name: 'gemini_analyze_audio', arguments: { source: 'voice.m4a' } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /absolute local path/);
});

test('audio: understanding uses the general model with audio/m4a', async () => {
  const result = await client.callTool({
    name: 'gemini_analyze_audio',
    arguments: { source: join(dir, 'voice.m4a'), prompt: 'Who speaks?' },
  });
  assert.equal(result.isError, undefined, textOf(result));
  const req = lastInteraction();
  assert.equal(req.body.model, 'gemini-3.8-flash');
  assert.equal(req.body.input[0].type, 'audio');
  assert.equal(req.body.input[0].mime_type, 'audio/m4a');
  assert.equal(req.body.input[0].resolution, undefined);
});

test('transcribe: speakers and timestamps by default, formatted transcript', async () => {
  const result = await client.callTool({
    name: 'gemini_transcribe_audio',
    arguments: { source: join(dir, 'voice.m4a'), languageCodes: ['es-PE'] },
  });
  assert.equal(result.isError, undefined, textOf(result));
  const text = textOf(result);
  assert.match(text, /^\[00:00\] spk_1: Hola Flavio\.\n\[01:05\] spk_2: Buenos días/m);
  assert.match(text, /model: gemini-3\.5-transcribe/);

  const req = lastInteraction();
  assert.equal(req.body.model, 'gemini-3.5-transcribe');
  assert.equal(req.body.input.length, 1);
  assert.deepEqual(req.body.generation_config, {
    transcription_config: {
      language_codes: ['es-PE'],
      mode: { type: 'verbatim', diarization_mode: 'speaker', timestamp_granularities: ['word'] },
    },
  });
});

test('transcribe: smart mode with vocabulary requires plain output', async () => {
  const bad = await client.callTool({
    name: 'gemini_transcribe_audio',
    arguments: { source: join(dir, 'voice.m4a'), mode: 'smart' },
  });
  assert.equal(bad.isError, true);

  const ok = await client.callTool({
    name: 'gemini_transcribe_audio',
    arguments: {
      source: join(dir, 'voice.m4a'),
      mode: 'smart',
      speakers: false,
      wordTimestamps: false,
      customVocabulary: ['ProspectIA', 'GKE'],
    },
  });
  assert.equal(ok.isError, undefined, textOf(ok));
  assert.deepEqual(lastInteraction().body.generation_config.transcription_config, {
    custom_vocabulary: ['ProspectIA', 'GKE'],
    mode: { type: 'smart' },
  });
});

test('image and document blocks', async () => {
  const img = await client.callTool({
    name: 'gemini_analyze_image',
    arguments: { source: join(dir, 'photo.png'), resolution: 'ultra_high' },
  });
  assert.equal(img.isError, undefined, textOf(img));
  let media = lastInteraction().body.input[0];
  assert.equal(media.type, 'image');
  assert.equal(media.mime_type, 'image/png');
  assert.equal(media.resolution, 'ultra_high');

  const doc = await client.callTool({
    name: 'gemini_analyze_document',
    arguments: { source: 'gs://bucket/report.pdf' },
  });
  assert.equal(doc.isError, undefined, textOf(doc));
  media = lastInteraction().body.input[0];
  assert.deepEqual(media, { type: 'document', uri: 'gs://bucket/report.pdf', mime_type: 'application/pdf' });
});

test('files: upload, reuse as source, list and delete', async () => {
  const up = await client.callTool({
    name: 'gemini_upload_file',
    arguments: { filePath: join(dir, 'large.mp4'), displayName: 'demo' },
  });
  assert.equal(up.isError, undefined, textOf(up));
  const name = textOf(up).match(/Name: (files\/\w+)/)[1];
  assert.match(textOf(up), /State: ACTIVE/);

  const reuse = await client.callTool({ name: 'gemini_analyze_video', arguments: { source: name } });
  assert.equal(reuse.isError, undefined, textOf(reuse));
  assert.match(lastInteraction().body.input[0].uri, new RegExp(`${name}$`));
  assert.ok(mock.files.has(name), 'reused file must not be deleted');

  const list = await client.callTool({ name: 'gemini_list_files', arguments: {} });
  assert.match(textOf(list), new RegExp(name));

  const del = await client.callTool({ name: 'gemini_delete_file', arguments: { fileName: name } });
  assert.equal(del.isError, undefined, textOf(del));
  assert.equal(mock.files.has(name), false);
});

test('long calls send progress notifications', async () => {
  const progress = [];
  const result = await client.callTool(
    { name: 'gemini_analyze_video', arguments: { source: join(dir, 'small.mp4'), prompt: 'SLOW' } },
    undefined,
    { onprogress: (p) => progress.push(p), resetTimeoutOnProgress: true },
  );
  assert.equal(result.isError, undefined, textOf(result));
  assert.ok(progress.length >= 3, `expected heartbeats, got ${progress.length}`);
  assert.match(progress[0].message, /Gemini is watching the video \(\d+s elapsed\)/);
});

function lastRequest(pattern) {
  return mock.requests.filter((r) => pattern.test(r.path)).at(-1);
}

test('chat: prompt, context file and system instruction', async () => {
  const result = await client.callTool({
    name: 'gemini_chat',
    arguments: {
      prompt: 'Review this',
      sources: [join(dir, 'report.pdf')],
      systemInstruction: 'Be blunt',
      thinkingLevel: 'medium',
    },
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.match(textOf(result), /A cat jumps/);
  const req = lastInteraction();
  assert.equal(req.body.system_instruction, 'Be blunt');
  assert.equal(req.body.store, false);
  assert.deepEqual(req.body.generation_config, { thinking_level: 'medium' });
  assert.equal(req.body.input[0].type, 'document');
  assert.deepEqual(req.body.input[1], { type: 'text', text: 'Review this' });
});

test('list models with filter', async () => {
  const result = await client.callTool({ name: 'gemini_list_models', arguments: { filter: 'embedding' } });
  const text = textOf(result);
  assert.match(text, /gemini-embedding-2 \(Gemini Embedding 2\)/);
  assert.doesNotMatch(text, /gemini-3\.8-flash/);
});

test('count tokens for a file and prompt', async () => {
  const result = await client.callTool({
    name: 'gemini_count_tokens',
    arguments: { prompt: 'Summarize', sources: [join(dir, 'small.mp4')] },
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.match(textOf(result), /Input tokens \(model: gemini-3\.8-flash\): 4321/);
  const req = lastRequest(/:countTokens$/);
  assert.match(req.path, /models\/gemini-3\.8-flash:countTokens$/);
  const parts = req.body.contents[0].parts;
  assert.equal(parts[0].inlineData.mimeType, 'video/mp4');
  assert.deepEqual(parts[1], { text: 'Summarize' });
});

test('embed: separate vectors saved to a file', async () => {
  const outputPath = join(dir, 'out', 'vectors.json');
  const result = await client.callTool({
    name: 'gemini_embed',
    arguments: { texts: ['a dog'], sources: [join(dir, 'photo.png')], dimensions: 768, outputPath },
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.match(textOf(result), /2 embedding\(s\), 768 dimensions \(model: gemini-embedding-2\)/);
  const saved = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(saved.items.length, 2);
  assert.equal(saved.items[0].values.length, 768);
  assert.equal(saved.items[1].input, join(dir, 'photo.png'));
  const req = lastRequest(/:(batchEmbedContents|embedContent)$/);
  assert.match(req.path, /gemini-embedding-2/);
});

test('embed: aggregate returns one vector, unsupported format rejected', async () => {
  const agg = await client.callTool({
    name: 'gemini_embed',
    arguments: { texts: ['a dog'], sources: [join(dir, 'photo.png')], mode: 'aggregate' },
  });
  assert.equal(agg.isError, undefined, textOf(agg));
  assert.match(textOf(agg), /^1 embedding\(s\)/);

  const bad = await client.callTool({
    name: 'gemini_embed',
    arguments: { sources: [join(dir, 'song.ogg')] },
  });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /not a format gemini-embedding-2 accepts/);
});

test('deep research: start, then collect the cited report', async () => {
  const start = await shortClient.callTool({
    name: 'gemini_deep_research',
    arguments: { query: 'History of TPUs', documents: [join(dir, 'big.pdf')] },
  });
  assert.equal(start.isError, undefined, textOf(start));
  // The document upload outlasts the one-second window, so the start itself becomes a job.
  const jobId = textOf(start).match(/Job ID: (job_\w+)/)[1];
  const started = await collectJob(shortClient, jobId);
  assert.match(textOf(started), /Interaction ID: res_1/);

  const req = mock.requests.filter((r) => r.path.endsWith('/interactions') && r.body?.agent).at(-1);
  assert.equal(req.body.agent, 'deep-research-preview-04-2026');
  assert.equal(req.body.background, true);
  assert.equal(req.body.store, true);
  assert.equal(req.body.agent_config.type, 'deep-research');
  assert.equal(req.body.input[0].type, 'document');
  const uploaded = req.body.input[0].uri.match(/(files\/mock\d+)$/)[1];
  assert.ok(mock.files.has(uploaded), 'research documents must not be deleted while research runs');
  assert.deepEqual(req.body.input[1], { type: 'text', text: 'History of TPUs' });

  const reportPath = join(dir, 'report.md');
  const done = await client.callTool({
    name: 'gemini_check_research',
    arguments: { interactionId: 'res_1', waitSeconds: 30, outputPath: reportPath },
  });
  assert.equal(done.isError, undefined, textOf(done));
  const text = textOf(done);
  assert.match(text, /Google announced the first TPU in 2016\./);
  assert.match(text, /## Sources\n- \[TPU paper\]\(https:\/\/example\.com\/tpu\)/);
  assert.equal((text.match(/example\.com\/tpu/g) || []).length, 1);
  assert.match(await readFile(reportPath, 'utf8'), /# TPU history/);
});

test('deep research: max depth uses the max agent', async () => {
  await client.callTool({
    name: 'gemini_deep_research',
    arguments: { query: 'x', depth: 'max' },
  });
  const req = mock.requests.filter((r) => r.path.endsWith('/interactions') && r.body?.agent).at(-1);
  assert.equal(req.body.agent, 'deep-research-max-preview-04-2026');
});

test('long calls return a job ID and the result arrives through gemini_job_status', async () => {
  const first = await shortClient.callTool({
    name: 'gemini_analyze_video',
    arguments: { source: join(dir, 'small.mp4'), prompt: 'SLOW' },
  });
  assert.equal(first.isError, undefined, textOf(first));
  const text = textOf(first);
  assert.match(text, /Still running after \d+s: Gemini is watching the video\./);
  const jobId = text.match(/Job ID: (job_\w+)/)[1];

  const done = await shortClient.callTool({
    name: 'gemini_job_status',
    arguments: { jobId, waitSeconds: 10 },
  });
  assert.equal(done.isError, undefined, textOf(done));
  assert.match(textOf(done), /A cat jumps onto a table at 00:12\./);

  const again = await shortClient.callTool({ name: 'gemini_job_status', arguments: { jobId } });
  assert.match(textOf(again), /A cat jumps/);

  const unknown = await shortClient.callTool({ name: 'gemini_job_status', arguments: { jobId: 'job_nope' } });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /Unknown job job_nope/);
});

test('job errors surface through gemini_job_status', async () => {
  const first = await shortClient.callTool({
    name: 'gemini_analyze_video',
    arguments: { source: join(dir, 'clip.mkv') },
  });
  assert.equal(first.isError, true);
  assert.match(textOf(first), /Supported extensions/);
});

test('search: Google grounding with sources and suggestions', async () => {
  const result = await client.callTool({
    name: 'gemini_search',
    arguments: { query: 'feriados Perú diciembre 2026' },
  });
  assert.equal(result.isError, undefined, textOf(result));
  const text = textOf(result);
  assert.match(text, /^El 8 de diciembre es feriado\./);
  assert.match(text, /Sources:\n- \[gob\.pe\]\(https:\/\/www\.gob\.pe\/feriados\)\n\n/);
  assert.equal((text.match(/gob\.pe\/feriados/g) || []).length, 1);
  assert.match(
    text,
    /Google Search suggestions:\n- \[feriados peru 2026\]\(https:\/\/www\.google\.com\/search\?q=feriados\+peru\+2026&client=app\)/,
  );
  assert.match(text, /searches run: 1/);
  assert.doesNotMatch(text, /Google Maps sources/);

  const req = lastInteraction();
  assert.deepEqual(req.body.tools, [{ type: 'google_search' }]);
  assert.equal(req.body.store, false);
  assert.deepEqual(req.body.input, [{ type: 'text', text: 'feriados Perú diciembre 2026' }]);
});

test('search: Maps grounding with coordinates', async () => {
  const result = await client.callTool({
    name: 'gemini_search',
    arguments: { query: 'cafés de especialidad cerca', maps: true, latitude: -12.12, longitude: -77.03 },
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.match(
    textOf(result),
    /Google Maps sources:\n- \[Café Tostado\]\(https:\/\/maps\.google\.com\/\?cid=1\) \(Google Maps\)/,
  );
  assert.deepEqual(lastInteraction().body.tools, [
    { type: 'google_search' },
    { type: 'google_maps', latitude: -12.12, longitude: -77.03 },
  ]);

  const bad = await client.callTool({
    name: 'gemini_search',
    arguments: { query: 'x', latitude: 1, longitude: 2 },
  });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /require maps=true/);
});
