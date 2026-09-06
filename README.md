# gptwrap

`gptwrap` exposes popular AI web apps through a small OpenAI-style HTTP API.

It uses Playwright to control persistent logged-in browser sessions, submits prompts through the normal consumer web UI, reads generated responses from the page, and returns them through `/v1/chat/completions`.

> [!IMPORTANT]
> gptwrap is a web UI wrapper, not an official API client for any provider. Web interfaces can change without notice and break selectors, model pickers, uploads, or streaming. Use it only with accounts and services you are authorized to automate and follow the relevant provider terms, limits, and policies.

## Providers

Built-in provider support:

| Provider | ID | Default web app |
| --- | --- | --- |
| ChatGPT | `chatgpt` | `chatgpt.com` |
| Gemini | `gemini` | `gemini.google.com` |
| Claude | `claude` | `claude.ai` |
| Grok | `grok` | `grok.com` |
| DeepSeek | `deepseek` | `chat.deepseek.com` |

Each provider gets its own persistent browser profile and request queue.

## Features

- OpenAI-style `POST /v1/chat/completions`
- ChatGPT, Gemini, Claude, Grok, and DeepSeek web-app support
- `system`, `developer`, `user`, `assistant`, and `tool` messages
- Model-aware provider routing
- Best-effort model selection in provider UIs
- Built-in model aliases plus custom aliases through `MODEL_MAP`
- Live `stream: true` Server-Sent Events
- OpenAI-style streamed chunks and `[DONE]`
- `stream_options.include_usage`
- `image_url` and `input_image`
- Remote HTTP(S) images and base64 `data:image/...` images
- Multiple image attachments
- OpenAI-style function/tool definitions
- Optional automatic tool execution through `TOOL_ENDPOINT`
- Persistent login profiles
- Real installed Chrome support with Playwright Chromium fallback
- Approximate token accounting with `js-tiktoken`

## Requirements

- Node.js 18+
- Google Chrome recommended
- An account for each provider you want to use

## Install

```bash
git clone https://github.com/kodexalol/gptwrap.git
cd gptwrap
npm install
npx playwright install chromium
```

The Playwright Chromium install is mainly a fallback. gptwrap prefers your installed Chrome because consumer login flows tend to behave better there.

## Login

Log in once for each provider you want to use:

```bash
node index.js login chatgpt
node index.js login gemini
node index.js login claude
node index.js login grok
node index.js login deepseek
```

A browser window opens. Sign in normally, return to the terminal, and press Enter. By default the profile is saved under:

```text
./profiles/<provider>
```

Running this with no provider walks through every configured provider:

```bash
node index.js login
```

You do not need to log in to providers you never intend to call.

## Run

```bash
node index.js
```

Default base URL:

```text
http://127.0.0.1:3000
```

Endpoints:

```text
GET  /health
GET  /v1/models
POST /v1/chat/completions
```

## Basic request

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-5",
    "messages": [
      {"role": "system", "content": "Be concise."},
      {"role": "user", "content": "Explain Roblox RemoteEvents."}
    ]
  }'
```

You can also explicitly choose a provider:

```json
{
  "provider": "grok",
  "model": "grok",
  "messages": [
    {"role": "user", "content": "Hello"}
  ]
}
```

The generic provider model IDs such as `chatgpt`, `claude`, or `grok` use whatever model/mode is currently selected in that web app.

## Model aliases

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

claude
claude-auto
claude-sonnet-5
claude-opus-5
claude-fable-5
claude-fable-5.1
claude-haiku-4.5

grok
grok-auto
grok-4.6
grok-4.5
grok-4.3
grok-reasoning

deepseek
deepseek-auto
deepseek-instant
deepseek-expert
deepseek-vision
deepseek-v4-flash
deepseek-v4-pro
```

Aliases are best-effort mappings to visible UI labels. Availability depends on the account, plan, region, and the provider's current web interface. Listing an alias does not grant access to a paid model. Tragically, JSON remains unable to negotiate subscription upgrades.

### Provider prefixes

Unknown model IDs can be prefixed with a provider using `:` or `/`:

```text
chatgpt:some-new-model
gemini/some-new-model
claude:some-new-model
grok/some-new-model
deepseek:some-new-model
```

gptwrap strips the provider prefix, creates reasonable label guesses, and tries those in the provider's model picker.

### Provider inference

Without an explicit `provider`, model IDs are routed by their name. Common GPT IDs route to ChatGPT, Gemini IDs to Gemini, Claude/Sonnet/Opus/Haiku/Fable IDs to Claude, Grok IDs to Grok, and DeepSeek IDs to DeepSeek. Unknown names fall back to ChatGPT.

### Custom model mapping

Use `MODEL_MAP` to add or override aliases without changing code:

```bash
export MODEL_MAP='{
  "my-claude": {
    "provider": "claude",
    "labels": ["Sonnet 5", "Claude Sonnet 5"]
  },
  "my-grok": {
    "provider": "grok",
    "labels": ["Grok 4.6"]
  }
}'
node index.js
```

Accepted label fields are `labels`, `uiLabels`, `label`, and `uiLabel`.

A shorthand string value is also accepted:

```bash
MODEL_MAP='{"my-model":"Instant"}' node index.js
```

### Strict selection

By default, if gptwrap cannot select a requested model it logs a warning and continues with the model currently selected in the web UI.

To fail instead:

```bash
MODEL_STRICT=1 node index.js
```

This is recommended when accidentally using a fallback model would be worse than returning an error.

## Streaming

Set `stream: true`:

```bash
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.6",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Explain CFrame in one paragraph."}
    ]
  }'
```

Streaming polls the live provider DOM while generation is happening. It does not wait for the complete answer and then fake a stream afterward.

The stream ends with:

```text
data: [DONE]
```

For a final usage chunk:

```json
{
  "stream": true,
  "stream_options": {
    "include_usage": true
  }
}
```

## Image input

Images are downloaded or decoded locally, temporarily written to disk, and uploaded into the provider's web composer.

```json
{
  "model": "claude-sonnet-5",
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "Describe this image."},
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

Base64 data URLs work too:

```text
data:image/png;base64,iVBORw0KGgoAAA...
```

`input_image` is also accepted.

Defaults:

- 10 images maximum per request
- 20 MB maximum per image
- 50 MB JSON body limit

Temporary image files are removed after each request.

Image support still depends on the selected provider/model supporting uploads in its web UI.

## Tool calling

Pass normal OpenAI-style function tools:

```json
{
  "model": "deepseek-v4-pro",
  "messages": [
    {"role": "user", "content": "What is the weather in London?"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {"type": "string"}
          },
          "required": ["location"]
        }
      }
    }
  ]
}
```

gptwrap injects a lightweight text tool protocol into the provider prompt.

If `TOOL_ENDPOINT` is not configured, a detected call is returned as an OpenAI-style `tool_calls` response to the API client.

If `TOOL_ENDPOINT` is configured, gptwrap sends:

```json
{
  "name": "get_weather",
  "arguments": {
    "location": "London"
  }
}
```

and feeds the result back into the same provider conversation automatically.

If `TOOL_SECRET` is set it is sent as:

```text
Authorization: Bearer <TOOL_SECRET>
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Local API port |
| `HEADLESS` | `0` | Set to `1` for headless browser mode |
| `PROFILE_ROOT` | `./profiles` | Persistent provider profiles |
| `TMP_ROOT` | `./profiles/.tmp` | Temporary image directory |
| `TIMEOUT` | `180000` | Provider response timeout in ms |
| `USE_REAL_CHROME` | `1` | Set to `0` to force Playwright Chromium |
| `CHROME_PATH` | empty | Custom Chrome/Chromium executable |
| `CHROME_USER_DATA_DIR` | empty | Existing Chrome user-data directory |
| `CHROME_PROFILE` | empty | Existing profile name such as `Default` |
| `CHATGPT_URL` | ChatGPT default | Override ChatGPT web URL |
| `GEMINI_URL` | Gemini default | Override Gemini web URL |
| `CLAUDE_URL` | `https://claude.ai/new` | Override Claude web URL |
| `GROK_URL` | `https://grok.com/` | Override Grok web URL |
| `DEEPSEEK_URL` | `https://chat.deepseek.com/` | Override DeepSeek web URL |
| `MODEL_MAP` | empty | JSON object adding/overriding model aliases |
| `MODEL_STRICT` | `0` | Fail if requested model cannot be selected |
| `MODEL_SELECT_TIMEOUT` | `6500` | Model selection timeout in ms |
| `TOOL_ENDPOINT` | empty | Optional automatic tool executor URL |
| `TOOL_SECRET` | empty | Optional bearer token for tool executor |
| `MAX_TOOL_LOOPS` | `8` | Maximum automatic tool-call iterations |
| `BODY_LIMIT` | `50mb` | Express JSON body limit |
| `MAX_IMAGES` | `10` | Maximum image attachments |
| `MAX_IMAGE_BYTES` | `20971520` | Maximum image bytes |
| `STREAM_POLL_MS` | `120` | Live DOM polling interval |
| `STREAM_STABLE_MS` | `1300` | Stable-response delay before completion |

## Existing Chrome profiles

You can point gptwrap at an existing Chrome user-data directory:

```bat
set CHROME_USER_DATA_DIR=C:\Users\YOUR_NAME\AppData\Local\Google\Chrome\User Data
set CHROME_PROFILE=Default
node index.js login claude
```

Close all normal Chrome windows first because Chrome locks active profiles. Dedicated gptwrap profiles are usually cleaner than sharing your everyday browser profile.

## Reliability

This project depends on consumer web UIs, so provider support is inherently best-effort. ChatGPT, Gemini, Claude, Grok, or DeepSeek can change their DOM at any time.

The wrapper deliberately uses several selector fallbacks for inputs, response containers, upload controls, and model pickers. New providers also share generic accessibility-based fallbacks rather than relying on a single brittle class name.

For best results:

- Prefer `HEADLESS=0`
- Prefer installed Chrome
- Log in manually once per provider
- Keep one request at a time per provider, which gptwrap does automatically
- Use `MODEL_STRICT=1` if exact model selection matters
- Use `MODEL_MAP` for new UI model labels before modifying core code
- Expect provider selectors to occasionally need maintenance after UI redesigns

The newer Claude, Grok, and DeepSeek adapters are less battle-tested than the original ChatGPT and Gemini adapters. Their public web apps and model labels can change quickly, so treat them as best-effort until tested against your own logged-in accounts.

## Health check

```bash
curl http://127.0.0.1:3000/health
```

The response includes all registered providers and reports streaming, image, tool-execution, and model-selection support.

## License

ISC
