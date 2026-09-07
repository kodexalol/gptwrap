# gptwrap

`gptwrap` exposes several consumer AI web apps through a small OpenAI-style HTTP gateway.

It uses Playwright with persistent logged-in browser profiles, submits prompts through the normal web UI, reads generated responses, and returns familiar `/v1/chat/completions` responses.

> **Important:** gptwrap is not an official API client for any provider. Consumer web UIs can change without notice. Use it only with accounts and services you are authorized to automate, and follow provider terms, subscriptions, quotas, limits, and policies.

## Providers

Built-in adapters:

- ChatGPT (`chatgpt`)
- Gemini (`gemini`)
- Claude (`claude`)
- Grok (`grok`)
- DeepSeek (`deepseek`)

## Features

- OpenAI-style `POST /v1/chat/completions`
- Multiple named accounts per provider
- Isolated persistent browser profile per account
- Concurrent requests across different accounts
- Explicit account routing by JSON field or HTTP header
- Live `stream: true` SSE
- Image inputs through `image_url` / `input_image`
- OpenAI-style function/tool definitions
- Optional automatic tool execution through `TOOL_ENDPOINT`
- API-key authentication
- Automatic browser recovery with conservative retries
- Best-effort model selection
- Runtime model discovery per account
- Provider/model/account metadata
- Custom model aliases through `MODEL_MAP`
- `.env` loading without another dependency
- Linux VPS support with Xvfb/systemd helpers

## How multi-account works

The existing `index.js` remains the single-profile provider engine. `multi.js` is the default gateway and starts isolated `index.js` child processes on private localhost ports as accounts are actually used.

```text
client -> multi.js :3000
             |
             +-> account default child :3100 -> profiles/<provider>
             +-> account plus2 child   :3101 -> profiles/accounts/plus2/<provider>
             +-> account team child    :3102 -> profiles/accounts/team/<provider>
```

Each account child keeps the same streaming, image, tools, recovery, provider routing, and model-discovery behaviour as the original engine. Different account children can run concurrently. Requests to one child are still serialized per provider by the core engine.

Children launch lazily, so configuring several accounts does not immediately spawn several browsers. Set `CHILD_IDLE_MS` if you want idle account children automatically shut down to reclaim RAM.

There is **no automatic account rotation to work around provider quotas or rate limits**. Routing is explicit or uses your configured default account.

## Install

```bash
git clone https://github.com/kodexalol/gptwrap.git
cd gptwrap
npm install
npx playwright install chromium
cp .env.example .env
```

Run the normal multi-account gateway:

```bash
npm start
```

Run the original single-profile engine directly:

```bash
npm run start:single
```

Default API:

```text
http://127.0.0.1:3000
```

## Multi-account setup

Configure account names in `.env` using one-line JSON:

```env
ACCOUNTS={"chatgpt":["default","plus2"],"claude":["default","team"],"gemini":["default"]}
DEFAULT_ACCOUNTS={"chatgpt":"default","claude":"team"}
```

`default` is always retained for compatibility with older single-account installs.

Profile layout:

```text
profiles/chatgpt                       # chatgpt/default, old profile remains valid
profiles/claude                        # claude/default
profiles/accounts/plus2/chatgpt        # chatgpt/plus2
profiles/accounts/team/claude          # claude/team
```

Account IDs may contain letters, numbers, `.`, `_`, and `-` and are limited to 64 characters.

By default only accounts listed in `ACCOUNTS` are accepted. To permit arbitrary safe account IDs:

```env
ALLOW_DYNAMIC_ACCOUNTS=1
```

That is mainly useful for trusted/local deployments. Otherwise a client being able to manufacture endless browser profiles would be a surprisingly efficient RAM benchmark.

### Log into named accounts

```bash
node multi.js login chatgpt default
node multi.js login chatgpt plus2
node multi.js login claude default
node multi.js login claude team
```

The npm helper uses the same command:

```bash
npm run login -- chatgpt plus2
```

If the account is omitted, the provider's configured default is used:

```bash
node multi.js login claude
```

List configured accounts and exact profile paths:

```bash
npm run accounts
npm run accounts -- chatgpt
```

### Route a request to an account

Use an `account` field:

```json
{
  "provider": "chatgpt",
  "account": "plus2",
  "model": "chatgpt",
  "messages": [
    {"role": "user", "content": "Hello"}
  ]
}
```

Or use a header, useful with clients that do not like custom body fields:

```text
X-GPTWrap-Account: plus2
```

Example:

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-GPTWrap-Account: plus2" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"gpt-5.6-sol",
    "messages":[{"role":"user","content":"Hello"}]
  }'
```

If no account is supplied, `DEFAULT_ACCOUNTS` is checked and then `default` is used.

## API authentication

Set:

```env
API_KEY=replace-this-with-a-long-random-secret
```

Then use either:

```text
Authorization: Bearer <API_KEY>
```

or:

```text
X-API-Key: <API_KEY>
```

`/health` remains public. `/v1/*` is protected when `API_KEY` is configured.

If `HOST` is not loopback, gptwrap refuses to start without `API_KEY` unless `ALLOW_UNAUTHENTICATED=1` is explicitly set.

The per-account child engines always bind only to `127.0.0.1` and use an internal random API key generated when the gateway starts. Those child ports are implementation details and should not be exposed publicly.

## Endpoints

```text
GET  /health
GET  /v1/accounts
GET  /v1/providers
GET  /v1/models
POST /v1/providers/:provider/discover
POST /v1/chat/completions
```

### List accounts

```bash
curl http://127.0.0.1:3000/v1/accounts \
  -H "Authorization: Bearer $API_KEY"
```

Filter by provider:

```text
GET /v1/accounts?provider=chatgpt
```

Account records include the profile path and whether the private account child is currently running.

## Model discovery per account

Different subscriptions can expose different model menus, so discovery can target a particular account.

CLI:

```bash
npm run discover -- claude team
```

API:

```bash
curl -X POST http://127.0.0.1:3000/v1/providers/claude/discover \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"account":"team"}'
```

Or:

```bash
curl "http://127.0.0.1:3000/v1/models?provider=claude&account=team&refresh=1" \
  -H "Authorization: Bearer $API_KEY"
```

Without an account filter, each provider's configured default account is used for model listing/discovery.

## Streaming

```bash
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"grok-4.6",
    "account":"default",
    "stream":true,
    "messages":[{"role":"user","content":"Explain CFrame briefly."}]
  }'
```

Streaming is proxied live from the selected account child. The gateway adds:

```text
X-GPTWrap-Account: <account>
```

Streams end with:

```text
data: [DONE]
```

Non-streaming JSON responses also include a top-level `account` compatibility extension.

## Images and tools

Image parts (`image_url`, `input_image`) and OpenAI-style function tools are passed unchanged to the selected account's core engine. HTTP(S) images, base64 `data:image/...` inputs, streaming tool calls, and optional `TOOL_ENDPOINT` execution keep the same behaviour as single-account mode.

Actual upload/model availability still depends on the selected provider account and its web UI.

## Automatic recovery

Defaults:

```env
AUTO_RECOVER=1
RECOVERY_RETRIES=1
```

Recovery remains inside each account child. A recoverable failure before submission can be retried after browser repair. A timeout after a known submission is not blindly resent, reducing duplicate messages.

If a child process itself exits, the multi-account gateway removes it from the runtime registry and starts a fresh child the next time that account is requested.

## Child lifecycle settings

```env
CHILD_PORT_BASE=3100
CHILD_START_TIMEOUT=30000
CHILD_IDLE_MS=0
```

`CHILD_PORT_BASE` is where private localhost child ports begin. `CHILD_START_TIMEOUT` controls startup health-check time. `CHILD_IDLE_MS=0` keeps used children alive; set something like `600000` to stop an account child after ten idle minutes.

## Linux VPS

The existing Debian/Ubuntu helpers continue to work:

```bash
bash scripts/vps-setup.sh
bash scripts/vps-display.sh
```

Optional systemd services:

```bash
bash scripts/install-systemd.sh
sudo systemctl start gptwrap-display.service
sudo systemctl start gptwrap.service
```

`gptwrap.service` uses `npm start`, so it now runs the multi-account gateway automatically.

For VPS-managed multi-account profiles, leave these empty:

```env
CHROME_USER_DATA_DIR=
CHROME_PROFILE=
```

A single external Chrome user-data directory cannot represent several isolated gptwrap accounts. Named accounts therefore use managed profile directories.

For software on the same VPS:

```env
HOST=127.0.0.1
```

For network access:

```env
HOST=0.0.0.0
API_KEY=a-long-random-secret
```

Use HTTPS plus an appropriate firewall/reverse proxy when exposing it beyond localhost.

Each provider/account still needs an authenticated web session initially, and providers may later require re-login or human verification. Multi-account support does not bypass those controls.

## Main `.env` options

```env
HOST=127.0.0.1
PORT=3000
API_KEY=

ACCOUNTS={"chatgpt":["default"],"gemini":["default"],"claude":["default"],"grok":["default"],"deepseek":["default"]}
DEFAULT_ACCOUNTS={}
ALLOW_DYNAMIC_ACCOUNTS=0
CHILD_PORT_BASE=3100
CHILD_START_TIMEOUT=30000
CHILD_IDLE_MS=0

HEADLESS=0
USE_REAL_CHROME=1
PROFILE_ROOT=./profiles
TMP_ROOT=./profiles/.tmp

AUTO_RECOVER=1
RECOVERY_RETRIES=1
AUTO_DISCOVER_MODELS=1
MODEL_DISCOVERY_TTL_MS=600000
MODEL_STRICT=0

TOOL_ENDPOINT=
TOOL_SECRET=
```

## Reliability notes

This wrapper depends on consumer web UIs. Selectors, model menus, uploads, authentication flows, and response containers can change at any time. Multi-account isolation prevents one named account's profile/session from contaminating another, but it cannot prevent providers from expiring sessions or requesting human verification.

## License

ISC
