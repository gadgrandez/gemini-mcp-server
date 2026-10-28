# Gemini MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude, or any MCP client, the ability to watch video, listen to audio and read documents through the Gemini API. The client sends a file or URL and a question; Gemini processes the media and returns text the client can keep working with. It also exposes Gemini capabilities an MCP client does not have on its own: Google Search and Google Maps grounding, Deep Research reports, multimodal embeddings, Gemini token counts and an independent second opinion.

Built on the [`@google/genai`](https://www.npmjs.com/package/@google/genai) SDK and the Gemini Interactions API. Fork of [salviz/gemini-mcp-server](https://github.com/salviz/gemini-mcp-server).

## Tools

| Tool | Purpose |
| --- | --- |
| `gemini_analyze_video` | Watch a video (frames and soundtrack) and answer a question. Local file, Files API name, https/gs URL or public YouTube URL. |
| `gemini_analyze_audio` | Listen to audio and answer a question: summary, speakers, tone, music, sound events, moments by `MM:SS`. |
| `gemini_transcribe_audio` | Transcript from the dedicated transcription model, with speaker labels and `MM:SS` timestamps. |
| `gemini_analyze_image` | Ask about an image, up to `ultra_high` resolution for dense text and small details. |
| `gemini_analyze_document` | Ask about a PDF or CSV, including scanned pages and figures. |
| `gemini_deep_research` | Start a Deep Research task: an agent that searches the web and writes a cited report. Optional PDFs or images as extra sources. |
| `gemini_check_research` | Collect a Deep Research report; call it again until the report is ready. |
| `gemini_search` | Answer with Google Search grounding, returning sources and Google's search suggestions. `maps: true` adds Google Maps grounding for places. |
| `gemini_embed` | Embeddings with `gemini-embedding-2` for text, images, audio, video and PDFs in one vector space. |
| `gemini_count_tokens` | Count input tokens for a prompt and files, to estimate cost before a large analysis. |
| `gemini_list_models` | List the Gemini models available to the API key. |
| `gemini_chat` | Ask a Gemini model directly, for a second opinion or review, with optional files as context. |
| `gemini_upload_file` | Upload a file once and reuse its `files/...` name across several questions. |
| `gemini_job_status` | Collect the result of a call that returned a job ID because it was still running. |
| `gemini_list_files` | List files stored in the Files API. |
| `gemini_delete_file` | Delete a file from the Files API. |

### Sources

Every analysis tool takes a `source`:

- An absolute local path. Files up to 20 MB are sent inline; larger files are uploaded to the Files API, used, and deleted afterwards.
- A Files API name such as `files/abc123`, returned by `gemini_upload_file`.
- An `https://` URL or a `gs://` URI.
- A public YouTube URL (video only).

Supported formats: MP4, MPEG, MOV, AVI, FLV, WebM, WMV and 3GP for video; WAV, MP3, AIFF, AAC, OGG, FLAC, M4A, Opus and WebM for audio; PNG, JPEG, WebP, HEIC, HEIF, GIF, BMP and TIFF for images; PDF and CSV for documents. Other containers, such as MKV, need conversion first (`ffmpeg -i in.mkv -c copy out.mp4`).

### Video processing

`gemini_analyze_video` uses agentic processing by default: the model navigates the timeline and loads transcript, frames or audio segments as it needs them, which uses far fewer tokens on long videos. Static processing samples frames at a fixed rate and is selected automatically when `startOffset`, `endOffset` or `fps` are set.

### Transcription

`gemini_transcribe_audio` labels speakers and adds timestamps by default. With either option enabled, audio is limited to 30 minutes; with both disabled, the limit is 1 hour. `customVocabulary` and `smart` mode require both options disabled.

### Deep Research

Deep Research takes several minutes. `gemini_deep_research` returns the report if it finishes within the call window and an interaction ID otherwise; `gemini_check_research` polls for up to `waitSeconds` per call and returns the report once it is ready. Both tools accept `outputPath` to save the report as Markdown. `depth: "max"` uses the more thorough agent. Deep Research runs in the background on Google's side, which stores the interaction there whatever `GEMINI_STORE` says. Documents passed to it stay in the Files API for 48 hours.

### Google Search

`gemini_search` returns Gemini's grounded answer followed by its sources, any Google Maps sources and Google's search suggestions as links. Google's terms for grounded results require showing them to the user together with their search suggestions and without modifying the grounded answer. With Gemini 3 and newer models, the first 5,000 search queries per month are free, shared across those models; after that, each query costs $14 per 1,000. One call can run several queries, and the response reports how many it ran.

### Embeddings

`gemini_embed` returns one vector per item by default, or a single vector for all items with `mode: "aggregate"`. Limits per request: 8,192 tokens, 6 images (PNG, JPEG), 180 seconds of audio (MP3, WAV), 120 seconds of video (MP4, MOV) and one PDF of up to 6 pages. Dimensions range from 128 to 3072 (default 3072). The response shows a preview; `outputPath` saves the full vectors as JSON.

## Requirements

- Node.js 24 LTS or later
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

## Installation

```bash
git clone https://github.com/gadgrandez/gemini-mcp-server.git
cd gemini-mcp-server
npm ci
npm test
```

### Claude Desktop

From the Claude menu in the system menu bar, open **Settings…**, go to the **Developer** tab and click **Edit Config**. The file lives at:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add the server under `mcpServers`, using the absolute path to `node` (`which node` on macOS, `where node` on Windows) and to `index.js`:

```json
{
  "mcpServers": {
    "gemini": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/you/gemini-mcp-server/index.js"],
      "env": {
        "GEMINI_API_KEY": "your-api-key"
      }
    }
  }
}
```

Quit Claude Desktop completely and open it again. To confirm the server loaded, click **Add files, connectors, and more** in the message box, open **Connectors → Manage connectors** and select **gemini**.

If it does not appear, the server's stderr is in `~/Library/Logs/Claude/mcp-server-gemini.log` on macOS and `%APPDATA%\Claude\logs\mcp-server-gemini.log` on Windows.

### Claude Code

```bash
claude mcp add gemini --scope user -e GEMINI_API_KEY=your-api-key -- node /absolute/path/to/gemini-mcp-server/index.js
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | (required) | Gemini API key. |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Model for video, audio, image and document analysis. `gemini-4-argon` for the most demanding questions. |
| `GEMINI_TRANSCRIBE_MODEL` | `gemini-3.5-transcribe` | Model for `gemini_transcribe_audio`. |
| `GEMINI_EMBEDDING_MODEL` | `gemini-embedding-2` | Model for `gemini_embed`. |
| `GEMINI_RESEARCH_AGENT` | `deep-research-preview-04-2026` | Deep Research agent for `depth: "standard"`. |
| `GEMINI_RESEARCH_MAX_AGENT` | `deep-research-max-preview-04-2026` | Deep Research agent for `depth: "max"`. |
| `GEMINI_THINKING_LEVEL` | `low` | `low`, `medium` or `high`. Each call can override it with `thinkingLevel`. |
| `GEMINI_MEDIA_RESOLUTION` | `medium` | `low`, `medium`, `high` or `ultra_high` tokens per image or video frame. Each call can override it with `resolution`. |
| `GEMINI_STORE` | `false` | Whether Google stores requests in the AI Studio logs of the API key's project. |
| `GEMINI_KEEP_UPLOADS` | `false` | Keep files uploaded on the client's behalf for 48 hours instead of deleting them after the call. |
| `GEMINI_INLINE_MAX_MB` | `20` | Largest file sent inline; larger files go through the Files API. |
| `GEMINI_TIMEOUT_MS` | `900000` | Maximum time for a single request to Gemini, including uploads. |
| `GEMINI_SYNC_WAIT_SECONDS` | `45` | Call window: how long a tool call waits before returning a job ID. `0` waits until the work finishes. |

Model IDs change as Google releases and retires models; the [Gemini API release notes](https://ai.google.dev/gemini-api/docs/changelog) list the current ones.

## Behavior notes

- Responses stream from the Interactions API, which keeps long video analyses alive without server-side storage.
- Every tool call returns within the call window (45 seconds by default), which keeps it under client and remote-bridge timeouts such as the 60-second limit when a claude.ai session reaches the server through the Claude desktop app. Work that takes longer keeps running in the server process and the call returns a job ID; `gemini_job_status` returns the result. Jobs are kept in memory for an hour after they finish and are lost if the server restarts.
- During long calls the server sends MCP progress notifications every 10 seconds.
- Each response ends with the model used and its token counts.
- Uploaded files count toward the Files API quota and expire after 48 hours.

## Development

```bash
npm test
```

The test suite starts the server over stdio against a local mock of the Gemini API and checks the requests it sends. It needs no API key.

## License

MIT
