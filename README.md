# gptwrap

`gptwrap` exposes the ChatGPT and Gemini web apps through a small OpenAI-style HTTP API.

It uses Playwright to control a logged-in browser session, submits prompts through the normal web UI, reads generated responses from the page, and returns them using familiar `/v1/chat/completions` response shapes.

> [!IMPORTANT]
> This is a web UI wrapper, not an official OpenAI or Google API client. Web interfaces can change without notice and break selectors or behaviour. Use it only with accounts and services you are authorized to automate, and follow the relevant service terms, limits, and policies.

## Features

- ChatGPT and Gemini web-app support
- OpenAI-style `POST /v1/chat/completions`
- `system`, `developer`, `user`, `assistant`, and `tool` messages
- Model-aware provider routing
- Best-effort model selection in the provider UI
- Built-in model aliases plus custom aliases through `MODEL_MAP`
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

Use `"model": "gemini"` to route to Gemini. You can also explicitly set `"provider": "chatgpt"` or `"provider": "gemini"`.

## Model selection

Unlike the first version of gptwrap, the `model` field is no longer just a routing label. For selectable model aliases, gptwrap opens the provider's model picker and tries to select the requested model before sending the prompt.

Built-in aliases currently include:

```text
chatgpt
chatgpt-auto
gpt-5.6
gpt-5.6-sol
gpt-5.6-luna
gpt-5.6-pro
chatgpt-instant
chatgpt-thinking

gemini
gemini-auto
gemini-fast
gemini-pro
gemini-thinking
```

The generic `chatgpt`, `chatgpt-auto`, `gemini`, and `gemini-auto` aliases do not force a UI model change. They use whichever model/configuration is currently selected in that provider.

Example:

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-sol",
    "messages": [
      {"role": "user", "content": "Write a Roblox inventory module."}
    ]
  }'
```

Model availability still depends on your account, plan, region, and what the provider currently exposes in its web UI. An alias being listed by gptwrap does not magically grant access to that model. Humanity has not yet discovered a JSON property that upgrades subscriptions.

### Unknown model IDs

Unknown IDs are not immediately rejected. gptwrap infers the provider and generates several likely UI labels from the requested ID.

For example:

```json
{
  "model": "gemini/some-new-model",
  "messages": [
    {"role": "user", "content": "Hello"}
  ]
}
```

will route to Gemini and try labels based on `some-new-model`.

Provider prefixes are supported using `:` or `/`, for example:

```text
chatgpt:my-model
chatgpt/my-model
gemini:my-model
gemini/my-model
```

### Custom model aliases

Use `MODEL_MAP` to add or override aliases without editing `index.js`.

`MODEL_MAP` is a JSON object. Each key is the API-facing model ID.

Example on Linux/macOS:

```bash
export MODEL_MAP='{
  "my-fast-gpt": {
    "provider": "chatgpt",
    "labels": ["Instant", "Fast"]
  },
  "my-deep-gemini": {
    "provider": "gemini",
    "labels": ["Deep Think", "Thinking"]
  }
}'
node index.js
```

Compact version:

```bash
MODEL_MAP='{"my-gpt":{"provider":"chatgpt","labels":["Instant"]}}' node index.js
```

A shorthand string value is also accepted:

```bash
MODEL_MAP='{"my-gpt":"Instant"}' node index.js
```

In shorthand form, the provider is inferred from the alias name.

Supported custom fields:

```json
{
  "my-model": {
    "provider": "chatgpt",
    "labels": ["UI label to try first", "fallback label"],
    "selectable": true
  }
}
```

`labels`, `uiLabels`, `label`, and `uiLabel` are accepted.

### Strict model selection

By default, model selection is best effort. If gptwrap cannot find the model picker or requested option, it logs a warning and continues using the current web UI model.

To fail the request instead:

```bash
MODEL_STRICT=1 node index.js
```

This is useful when silently falling back to another model would be worse than returning an error.

### List models

```bash
curl http://127.0.0.1:3000/v1/models
```

The response includes built-in aliases plus aliases loaded through `MODEL_MAP`.

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

To receive a final usage chunk:

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
| `MODEL_MAP` | empty | JSON object adding or overriding model aliases |
| `MODEL_STRICT` | `0` | Set to `1` to error when requested model selection fails |
| `MODEL_SELECT_TIMEOUT` | `6000` | Maximum time to find a requested model option, in ms |
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
2. Otherwise, aliases in the model map use their configured provider.
3. Unknown model IDs containing `gemini` route to Gemini.
4. Unknown IDs beginning with `gpt-`, common `o...` model-style names, or ChatGPT-prefixed IDs route to ChatGPT.
5. Everything else defaults to ChatGPT.

If an explicit `provider` conflicts with a known model alias, model selection fails rather than trying to click a model from the wrong provider.

## Compatibility notes

gptwrap aims to provide the common parts of the OpenAI Chat Completions format, but it is not a complete implementation of the OpenAI API.

Currently supported:

- Chat completions
- Message roles
- Model aliases and best-effort web model selection
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
- Guaranteed model selection across every provider UI revision
- Full OpenAI parameter parity such as every sampling/logprob option

Unknown request fields may simply have no effect because the underlying operation is performed through the provider's web interface.

## Reliability

This wrapper depends on DOM selectors and web UI behaviour. ChatGPT or Gemini can change their interface at any time, which may require updating selectors in `PROVIDERS` inside `index.js`.

Model selection is especially UI-dependent. To reduce breakage, gptwrap searches several accessible roles and label variants rather than depending on one exact option selector.

For best reliability:

- Keep `HEADLESS=0` unless you specifically need headless mode
- Prefer installed Chrome over bundled Chromium
- Keep requests serialized per provider
- Use `MODEL_STRICT=1` when choosing the wrong model would be unacceptable
- Add new aliases through `MODEL_MAP` before changing core code
- Do not use the same Chrome profile simultaneously in regular Chrome and gptwrap
- Re-run the login command if a saved session expires

## Health check

```bash
curl http://127.0.0.1:3000/health
```

The health response reports streaming, image, and model-selection support and includes the currently registered model aliases.

## License

ISC
