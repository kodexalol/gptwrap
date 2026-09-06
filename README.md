# gptwrap

`gptwrap` exposes several consumer AI web apps through a small OpenAI-style HTTP gateway.

It uses Playwright with persistent logged-in browser profiles, submits prompts through the normal web UI, reads the generated response, and returns familiar `/v1/chat/completions` responses.

> [!IMPORTANT]
> gptwrap is not an official API client for any provider. Consumer web interfaces can change without notice and break selectors, uploads, streaming, or model pickers. Use it only with accounts and services you are authorized to automate, and follow the relevant provider terms, limits, and policies.

## Providers

| Provider | ID | Default web app |
| --- | --- | --- |
| ChatGPT | `chatgpt` | `chatgpt.com` |
| Gemini | `gemini` | `gemini.google.com` |
| Claude | `claude` | `claude.ai` |
| Grok | `grok` | `grok.com` |
| DeepSeek | `deepseek` | `chat.deepseek.com` |

Each provider gets its own persistent browser profile and serialized request queue.

## Features

- OpenAI-style `POST /v1/chat/completions`
- ChatGPT, Gemini, Claude, Grok, and DeepSeek
- `system`, `developer`, `user`, `assistant`, and `tool` messages
- Live `stream: true` SSE
- Image inputs through `image_url` / `input_image`
- OpenAI-style function/tool definitions
- Optional automatic tool execution through `TOOL_ENDPOINT`
- API-key authentication
- Safe refusal to expose an unauthenticated non-loopback server by default
- Automatic browser recovery and conservative retrying
- Best-effort model selection
- Runtime model discovery from the visible provider model picker
- Per-provider and per-model capability flags
- Custom aliases through `MODEL_MAP`
- Persistent login profiles
- `.env` loading without another dependency
- Linux VPS support with Xvfb + private noVNC login flow
- Optional systemd services
- Approximate token accounting with `js-tiktoken`

## Requirements

For a normal desktop install:

- Node.js 18+
- Chrome recommended, or Playwright Chromium
- An account for each provider you want to use

## Local install

```bash
git clone https://github.com/kodexalol/gptwrap.git
cd gptwrap
npm install
npx playwright install chromium
cp .env.example .env
```

Then log into whichever providers you want:

```bash
node index.js login chatgpt
node index.js login gemini
node index.js login claude
node index.js login grok
node index.js login deepseek
```

You do not need to log into providers you never plan to call.

Run the server:

```bash
npm start
```

Default base URL:

```text
http://127.0.0.1:3000
```

## API authentication

Set an API key in `.env`:

```env
API_KEY=replace-this-with-a-long-random-secret
```

Then use normal Bearer auth:

```bash
curl http://127.0.0.1:3000/v1/models \
  -H "Authorization: Bearer replace-this-with-a-long-random-secret"
```

`X-API-Key` is also accepted:

```text
X-API-Key: replace-this-with-a-long-random-secret
```

`/health` stays public so a process manager or reverse proxy can check that the service itself is alive. All `/v1/*` routes are protected when `API_KEY` is configured.

If the server binds to anything other than loopback, such as:

```env
HOST=0.0.0.0
```

gptwrap refuses to start unless an `API_KEY` is configured. You can override that with `ALLOW_UNAUTHENTICATED=1`, but that is intentionally not the default because the gateway controls logged-in provider sessions.

## Endpoints

```text
GET  /health
GET  /v1/providers
GET  /v1/models
POST /v1/providers/:provider/discover
POST /v1/chat/completions
```

## Basic request

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
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

Generic IDs such as `chatgpt`, `claude`, or `grok` use the model/mode currently selected in that provider's web UI.

## Streaming

Set `stream: true`:

```bash
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.6",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Explain CFrame in one paragraph."}
    ]
  }'
```

The wrapper polls the live DOM while the provider generates. The stream ends with:

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

Base64 data URLs are also accepted:

```text
data:image/png;base64,iVBORw0KGgoAAA...
```

`input_image` is accepted too. By default, requests can contain up to 10 images, 20 MB each, with a 50 MB JSON request limit. Temporary files are removed after the request.

Actual vision/upload availability still depends on the selected provider and model.

## Tool calling

Pass OpenAI-style function tools:

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

gptwrap injects a lightweight tool-call protocol into the web prompt. If `TOOL_ENDPOINT` is unset, the detected call is returned to the API client as an OpenAI-style `tool_calls` response.

If `TOOL_ENDPOINT` is configured, gptwrap can execute it automatically and feed the result back into the provider conversation.

If `TOOL_SECRET` is set, the tool request includes:

```text
Authorization: Bearer <TOOL_SECRET>
```

## Automatic recovery

Consumer AI pages occasionally crash, navigate strangely, lose a renderer, or move the composer. gptwrap now tracks recoveries per provider and can repair the active page automatically.

Default behaviour:

```env
AUTO_RECOVER=1
RECOVERY_RETRIES=1
```

For failures that happen before the prompt is known to have been submitted, gptwrap can reload/reopen the page and retry once.

If a response times out after submission, the browser is repaired for future requests but the request is **not automatically resent**. This avoids accidentally submitting the same prompt twice.

Runtime recovery state is visible at:

```text
GET /v1/providers
```

Example fields include:

```json
{
  "runtime": {
    "started": true,
    "page_open": true,
    "selected_model": "Sonnet 5",
    "recoveries": 1,
    "last_error": null,
    "last_recovery_at": null
  }
}
```

## Model selection and discovery

Built-in aliases still provide convenient routing, but gptwrap can now inspect the provider's visible model picker and register what it actually sees.

Built-in aliases include IDs such as:

```text
gpt-5.6-sol
gpt-5.6-luna
gemini-pro
gemini-thinking
claude-sonnet-5
claude-opus-5
grok-4.6
grok-reasoning
deepseek-v4-flash
deepseek-v4-pro
```

### Discover one provider

From the CLI:

```bash
node index.js discover claude
```

Through the API:

```bash
curl -X POST http://127.0.0.1:3000/v1/providers/claude/discover \
  -H "Authorization: Bearer $API_KEY"
```

### Refresh `/v1/models`

```bash
curl "http://127.0.0.1:3000/v1/models?provider=claude&refresh=1" \
  -H "Authorization: Bearer $API_KEY"
```

To attempt discovery across every configured provider:

```bash
curl "http://127.0.0.1:3000/v1/models?refresh=1" \
  -H "Authorization: Bearer $API_KEY"
```

Discovery opens the provider's visible model/mode picker, collects plausible model labels, closes the menu, and caches the result. The default cache TTL is 10 minutes.

Discovered IDs look like:

```text
claude/sonnet-5
grok/grok-4.6
```

The exact IDs depend on the labels actually visible to your account.

### Capability flags

`GET /v1/providers` and `GET /v1/models` include capability flags:

```json
{
  "capabilities": {
    "chat_completions": true,
    "streaming": true,
    "tool_calling": true,
    "image_input": true,
    "model_selection": true,
    "model_discovery": true
  }
}
```

These describe wrapper support. A provider or individual account can still restrict a feature in its current UI, so web-UI-dependent features remain best-effort.

### Custom aliases

Use `MODEL_MAP` to add or override aliases without editing `index.js`:

```env
MODEL_MAP={"my-claude":{"provider":"claude","labels":["Sonnet 5"]}}
```

Accepted label fields are `labels`, `uiLabels`, `label`, and `uiLabel`.

Set:

```env
MODEL_STRICT=1
```

to make a failed model selection return an error instead of continuing with the model currently active in the UI.

## Linux VPS setup

A VPS usually has no physical display. Logging into consumer web apps is therefore the awkward part, because apparently servers were not designed around clicking “Continue with Google.”

The included setup uses:

- Xvfb for a virtual X11 display
- Fluxbox as a tiny window manager
- x11vnc
- noVNC/websockify bound to **localhost only**
- an SSH tunnel from your PC to view the VPS browser
- persistent gptwrap profiles so this is mainly a one-time login step
- optional systemd services afterward

The helper currently targets Debian/Ubuntu-style systems using `apt-get`.

### 1. Clone and install

On the VPS:

```bash
git clone https://github.com/kodexalol/gptwrap.git
cd gptwrap
bash scripts/vps-setup.sh
```

The setup script:

- installs Xvfb, noVNC, x11vnc, Fluxbox, and supporting packages
- makes sure Node.js 18+ is available
- installs npm dependencies
- installs Playwright Chromium and its dependencies
- creates `.env` from `.env.example` if needed
- generates a random API key
- configures the VPS to use Playwright Chromium by default

### 2. Start the private virtual desktop

On the VPS:

```bash
bash scripts/vps-display.sh
```

Leave that running during login.

By default:

```text
DISPLAY=:99
VNC:    127.0.0.1:5900
noVNC:  127.0.0.1:6080
```

The VNC/noVNC listeners are localhost-only.

### 3. Tunnel noVNC to your PC

On your own PC:

```bash
ssh -L 6080:127.0.0.1:6080 youruser@your-vps
```

Then open this on your PC:

```text
http://127.0.0.1:6080/vnc.html?autoconnect=1
```

You should now see the VPS virtual desktop in your browser without exposing VNC publicly.

### 4. Log into providers

Open another SSH session to the VPS:

```bash
cd gptwrap
export DISPLAY=:99
node index.js login chatgpt
```

The provider browser appears inside the noVNC window on your PC. Log in normally, then return to the SSH terminal and press Enter.

Repeat only for providers you need:

```bash
node index.js login gemini
node index.js login claude
node index.js login grok
node index.js login deepseek
```

The saved profiles live under `./profiles/<provider>` by default.

### 5. Test the API manually

```bash
npm run check
npm start
```

From another VPS shell:

```bash
API_KEY="$(grep '^API_KEY=' .env | cut -d= -f2-)"

curl http://127.0.0.1:3000/v1/models \
  -H "Authorization: Bearer $API_KEY"
```

### 6. Install systemd services

Stop the manually running `scripts/vps-display.sh` first, then:

```bash
bash scripts/install-systemd.sh
sudo systemctl start gptwrap-display.service
sudo systemctl start gptwrap.service
```

The installer enables both services for boot but deliberately does not start them itself, so it does not collide with the manual display you used for login.

Useful commands:

```bash
sudo systemctl status gptwrap.service
sudo journalctl -u gptwrap.service -f
sudo systemctl restart gptwrap.service
```

The virtual display remains available after boot, which lets the normal `HEADLESS=0` browser sessions run without a physical monitor.

### Accessing the VPS API

There are three sensible patterns.

**Same VPS:** keep:

```env
HOST=127.0.0.1
```

and let your app talk to `127.0.0.1:3000` directly.

**SSH tunnel:** also keep loopback, then from your PC or another trusted machine:

```bash
ssh -L 3000:127.0.0.1:3000 youruser@your-vps
```

**Network/reverse proxy:** set:

```env
HOST=0.0.0.0
API_KEY=a-long-random-secret
```

and put it behind your firewall/reverse proxy as appropriate. gptwrap will refuse the non-loopback bind if no API key is configured unless `ALLOW_UNAUTHENTICATED=1` is explicitly set.

## `.env` configuration

The application automatically loads `.env` from the current working directory.

Main settings:

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | API bind host |
| `PORT` | `3000` | API port |
| `API_KEY` | empty | Bearer/X-API-Key secret for `/v1/*` |
| `ALLOW_UNAUTHENTICATED` | `0` | Allow non-loopback bind without API auth |
| `HEADLESS` | `0` | Use browser headless mode |
| `PROFILE_ROOT` | `./profiles` | Persistent provider profiles |
| `TMP_ROOT` | `./profiles/.tmp` | Temporary image directory |
| `USE_REAL_CHROME` | `1` | Prefer installed Chrome |
| `CHROME_PATH` | empty | Custom Chrome/Chromium executable |
| `CHROME_USER_DATA_DIR` | empty | Existing Chrome data directory |
| `CHROME_PROFILE` | empty | Chrome profile such as `Default` |
| `NO_SANDBOX` | `0` | Add Chromium no-sandbox flags if your environment truly requires it |
| `AUTO_RECOVER` | `1` | Repair failed provider pages automatically |
| `RECOVERY_RETRIES` | `1` | Safe pre-submit retries |
| `TIMEOUT` | `180000` | Provider response timeout in ms |
| `MODEL_MAP` | empty | Custom JSON model aliases |
| `MODEL_STRICT` | `0` | Error if exact model selection fails |
| `MODEL_SELECT_TIMEOUT` | `6500` | Model picker timeout in ms |
| `AUTO_DISCOVER_MODELS` | `1` | Try discovery for unknown model IDs |
| `MODEL_DISCOVERY_TTL_MS` | `600000` | Discovery cache TTL |
| `BODY_LIMIT` | `50mb` | Express JSON body limit |
| `MAX_IMAGES` | `10` | Image count limit |
| `MAX_IMAGE_BYTES` | `20971520` | Per-image byte limit |
| `STREAM_POLL_MS` | `120` | DOM stream polling interval |
| `STREAM_STABLE_MS` | `1300` | Stable-response completion delay |
| `TOOL_ENDPOINT` | empty | Optional tool executor URL |
| `TOOL_SECRET` | empty | Optional tool executor bearer secret |
| `MAX_TOOL_LOOPS` | `8` | Maximum automatic tool iterations |

Provider URLs can also be overridden with `CHATGPT_URL`, `GEMINI_URL`, `CLAUDE_URL`, `GROK_URL`, and `DEEPSEEK_URL`.

## Existing Chrome profiles

You can point gptwrap at an existing Chrome user-data directory:

```bat
set CHROME_USER_DATA_DIR=C:\Users\YOUR_NAME\AppData\Local\Google\Chrome\User Data
set CHROME_PROFILE=Default
node index.js login claude
```

Close normal Chrome first because Chrome locks an active profile. Dedicated gptwrap profiles are usually cleaner than sharing your everyday browser profile.

## Reliability notes

This project depends on consumer web UIs, so support is inherently best-effort. Providers can change their DOM at any time.

For best results:

- Prefer a visible browser (`HEADLESS=0`) when possible
- Log in manually once per provider
- Keep provider profiles persistent
- Use `MODEL_STRICT=1` when using the wrong model would be unacceptable
- Refresh model discovery after provider UI/model changes
- Keep `AUTO_RECOVER=1`
- Do not expose the service publicly without API auth
- Expect selectors to occasionally require maintenance after major UI redesigns

The Claude, Grok, and DeepSeek adapters are newer and less battle-tested than the original ChatGPT/Gemini adapters.

## Health check

```bash
curl http://127.0.0.1:3000/health
```

Example fields include browser mode, providers, auth state, recovery configuration, streaming, images, and model discovery.

## License

ISC
