# gptwrap

`gptwrap` exposes the ChatGPT and Gemini web apps through a small OpenAI-style HTTP API.

It uses Playwright to control a logged-in browser session, submits prompts through the normal web UI, reads the generated response from the page, and returns it using familiar `/v1/chat/completions` response shapes.

> [!IMPORTANT]
> This project is a web UI wrapper, not an official OpenAI or Google API client. Web interfaces can change without notice and break selectors or behaviour. Use it only with accounts and services you are authorized to automate, and follow the relevant service terms, limits, and policies.

## Features

- ChatGPT and Gemini support
- OpenAI-style `POST /v1/chat/completions`
- `system`, `developer`, `user`, `assistant`, and `tool` message handling
- Live `stream: true` Server-Sent Events (SSE)
- OpenAI-style streamed chunks and `[DONE]`
- `stream_options.include_usage`
- Image inputs using `image_url` and `input_image`
- Remote `http://` / `https://` images
- Base64 `data:image/...` inputs
- Multiple image attachments
- OpenAI-style function/tool definitions
- Optional local tool execution through a configurable HTTP endpoint
- Persistent browser profiles so you only need to log in once
- Real installed Chrome support, with bundled Chromium as a fallback
- Approximate token usage reporting using `js-tiktoken`

## Requirements

- Node.js 18+ recommended
- Google Chrome recommended
- A ChatGPT and/or Gemini account you are allowed to use

## Install

```bash
git clone https://github.com/kodexalol/gptwrap.git
cd gptwrap
npm install
npx playwright install chromium
```

The Playwright Chromium install is mainly a fallback. By default, gptwrap tries to use your installed Chrome because login flows are generally more reliable there.

## Log in

Log in to each provider once before starting the API server:

```bash
node index.js login chatgpt
node index.js login gemini
```

A browser window will open. Sign in normally, then return to the terminal and press Enter. The browser profile is saved under `./profiles/<provider>` by default.

To log in to both providers in sequence:

```bash
node index.js login
```

## Run

```bash
node index.js
```

The API listens on:

```text
http://127.0.0.1:3000
```

Available endpoints:

```text
GET  /health
GET  /v1/models
POST /v1/chat/completions
```

## Basic chat completion

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chatgpt",
    "messages": [
      {"role": "system", "content": "Be concise."},
      {"role": "user", "content": "Explain Roblox RemoteEvents."}
    ]
  }'
```

Use `"model": "gemini"` to route the request to Gemini. You can also explicitly set `"provider": "chatgpt"` or `"provider": "gemini"`.

## Streaming

Set `stream` to `true` to receive OpenAI-style SSE chunks while the web app is generating:

```bash
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chatgpt",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Write a short explanation of CFrame."}
    ]
  }'
```

A stream ends with:

```text
data: [DONE]
```

To receive a final usage chunk, use:

```json
{
  "stream": true,
  "stream_options": {
    "include_usage": true
  }
}
```

Streaming is read from the live DOM as ChatGPT or Gemini generates. It is not simulated by waiting for the full response and splitting it afterward.

## Image input

Images are uploaded into the provider's web composer before the prompt is submitted.

### Remote image URL

```json
{
  "model": "chatgpt",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Describe this image."
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "https://example.com/image.png"
          }
        }
      ]
    }
  ]
}
```

### Base64 data URL

```json
{
  "model": "gemini",
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "What is shown here?"},
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,iVBORw0KGgoAAA..."
          }
        }
      ]
    }
  ]
}
```

`input_image` is also accepted.

By default:

- Maximum images per request: `10`
- Maximum size per image: `20 MB`
- JSON request body limit: `50 MB`

Temporary image files are deleted after each request.

## Tool calling

Pass OpenAI-style function tools in the request:

```json
{
  "model": "chatgpt",
  "messages": [
    {"role": "user", "content": "What is the weather in London?"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather for a location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {"type": "string"}
          },
          "required": ["location"]
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

gptwrap injects a lightweight tool protocol into the web prompt. If the model requests a tool and `TOOL_ENDPOINT` is not configured, gptwrap returns an OpenAI-style `tool_calls` response to the API client.

If `TOOL_ENDPOINT` is configured, gptwrap can execute the tool itself and continue the conversation automatically.

The tool endpoint receives:

```json
{
  "name": "get_weather",
  "arguments": {
    "location": "London"
  }
}
```

If `TOOL_SECRET` is set, it is sent as:

```text
Authorization: Bearer <TOOL_SECRET>
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Local API port |
| `HEADLESS` | `0` | Set to `1` to run the browser headlessly |
| `PROFILE_ROOT` | `./profiles` | Directory used for persistent provider profiles |
| `TMP_ROOT` | `./profiles/.tmp` | Temporary image download directory |
| `TIMEOUT` | `180000` | Maximum provider response wait in milliseconds |
| `USE_REAL_CHROME` | `1` | Set to `0` to force Playwright Chromium |
| `CHROME_PATH` | empty | Optional custom Chrome/Chromium executable |
| `CHROME_USER_DATA_DIR` | empty | Optional existing Chrome user-data directory |
| `CHROME_PROFILE` | empty | Chrome profile name such as `Default` or `Profile 1` |
| `CHATGPT_URL` | `https://chatgpt.com/?temporary-chat=true` | ChatGPT page to open |
| `GEMINI_URL` | `https://gemini.google.com/app` | Gemini page to open |
| `TOOL_ENDPOINT` | empty | Optional HTTP endpoint for automatic tool execution |
| `TOOL_SECRET` | empty | Optional bearer token for the tool endpoint |
| `MAX_TOOL_LOOPS` | `8` | Maximum automatic tool-call iterations |
| `BODY_LIMIT` | `50mb` | Express JSON request body limit |
| `MAX_IMAGES` | `10` | Maximum image attachments per request |
| `MAX_IMAGE_BYTES` | `20971520` | Maximum bytes per image |
| `STREAM_POLL_MS` | `120` | DOM polling interval during streaming |
| `STREAM_STABLE_MS` | `1300` | Stable-response delay before considering generation complete |

## Reusing your normal Chrome profile

You can point gptwrap at an existing Chrome user-data directory so it can inherit an existing login.

On Windows, for example:

```bat
set CHROME_USER_DATA_DIR=C:\Users\YOUR_NAME\AppData\Local\Google\Chrome\User Data
set CHROME_PROFILE=Default
node index.js login chatgpt
```

Close all normal Chrome windows first. Chrome locks an active profile and Playwright cannot safely open the same profile at the same time.

Using a dedicated gptwrap profile is usually cleaner and safer than sharing your everyday browser profile.

## Provider routing

Provider selection works like this:

1. If `provider` is explicitly set to `chatgpt` or `gemini`, that provider is used.
2. Otherwise, a model name containing `gemini` routes to Gemini.
3. Everything else routes to ChatGPT.

`model` is primarily used for routing and response compatibility. gptwrap does not currently control the exact model selected inside each provider's web UI.

## Compatibility notes

gptwrap aims to provide the common parts of the OpenAI Chat Completions format, but it is not a complete implementation of the OpenAI API.

Currently supported:

- Chat completions
- Message roles
- Streaming text
- Streaming tool calls
- Tool definitions and `tool_choice`
- Image attachments
- Approximate usage counts

Not currently implemented as full API-compatible features:

- OpenAI Responses API
- Audio input/output
- File/document APIs
- Exact provider-side token usage
- Exact web-model selection
- Full OpenAI parameter parity such as every sampling/logprob option

Unknown request fields may simply have no effect because the underlying operation is performed through the provider's web interface.

## Reliability

This wrapper depends on DOM selectors and web UI behaviour. ChatGPT or Gemini can change their interface at any time, which may require updating selectors in `PROVIDERS` inside `index.js`.

For best reliability:

- Keep `HEADLESS=0` unless you specifically need headless mode
- Prefer installed Chrome over bundled Chromium
- Keep requests serialized per provider
- Do not use the same Chrome profile simultaneously in regular Chrome and gptwrap
- Re-run the login command if a saved session expires

## Health check

```bash
curl http://127.0.0.1:3000/health
```

Example response:

```json
{
  "ok": true,
  "providers": ["chatgpt", "gemini"],
  "browser": "real-chrome",
  "toolExecution": false,
  "tokenizer": "cl100k_base",
  "streaming": true,
  "images": true
}
```

## License

ISC
