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
- Provider/model/account capability and health metadata
- Custom model aliases through `MODEL_MAP`
- `.env` loading without another dependency
- Linux VPS support with Xvfb/systemd helpers

## Install

```bash
git clone https://github.com/kodexalol/gptwrap.git
cd gptwrap
npm install
npx playwright install chromium
cp .env.example .env
```

Run:

```bash
npm start
```

Default API:

```text
http://127.0.0.1:3000
```

## Multi-account setup

Configure account names in `.env` with one-line JSON:

```env
ACCOUNTS={"chatgpt":["default","plus2"],"claude":["default","team"],"gemini":["default"]}
DEFAULT_ACCOUNTS={"chatgpt":"default","claude":"team"}
```

`default` is always retained for compatibility with older single-account installs.

Profile layout:

```text
profiles/chatgpt                         # chatgpt/default, old profile stays valid
profiles/claude                          # claude/default
profiles/accounts/chatgpt/plus2          # chatgpt/plus2
profiles/accounts/claude/team            # claude/team
```

Account IDs may contain letters, numbers, `.`, `_`, and `-` and are limited to 64 characters.

By default the API only accepts accounts listed in `ACCOUNTS`. You can allow arbitrary safe account names with:

```env
ALLOW_DYNAMIC_ACCOUNTS=1
```

That is mainly useful for private/local deployments. A public client being able to create unlimited browser profiles is otherwise a fairly creative denial-of-service feature.

### Log into each account

```bash
node index.js login chatgpt default
node index.js login chatgpt plus2
node index.js login claude default
node index.js login claude team
```

If you omit the account, the provider's configured default is used:

```bash
node index.js login claude
```

List configured accounts and profile paths:

```bash
node index.js accounts
node index.js accounts chatgpt
```

### Route an API request to an account

JSON field:

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

Or use a header:

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

If `account` is omitted, `DEFAULT_ACCOUNTS` is checked and then `default` is used.

There is **no automatic account rotation to work around provider quotas or rate limits**. Account selection is explicit/default-based. Each account simply has its own authorized session and request queue.

### Account concurrency

Each `provider/account` pair has its own Playwright context, page, queue, selected-model state, recovery counters, and discovery cache. For example, `chatgpt/default` and `chatgpt/plus2` can process requests at the same time, while requests sent to the same account stay serialized.

Browsers are started lazily when an account is first used, so configuring ten accounts does not immediately open ten Chrome processes.

## API authentication

Set:

```env
API_KEY=replace-this-with-a-long-random-secret
```

Then use:

```text
Authorization: Bearer <API_KEY>
```

or:

```text
X-API-Key: <API_KEY>
```

`/health` remains public. `/v1/*` is protected when `API_KEY` is set.

If `HOST` is not loopback, gptwrap refuses to start without `API_KEY` unless `ALLOW_UNAUTHENTICATED=1` is explicitly set.

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

The response includes the account's profile path and current runtime/recovery state.

## Model discovery per account

Different subscriptions can expose different model menus, so discovery is account-aware.

CLI:

```bash
node index.js discover claude team
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

Discovered model metadata includes the accounts on which that model label was observed.

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

Streams end with:

```text
data: [DONE]
```

Responses/chunks also include the selected gptwrap `account` as a top-level compatibility extension.

## Images

OpenAI-style image parts are accepted:

```json
{
  "model":"claude",
  "account":"team",
  "messages":[{
    "role":"user",
    "content":[
      {"type":"text","text":"Describe this image."},
      {"type":"image_url","image_url":{"url":"https://example.com/image.png"}}
    ]
  }]
}
```

HTTP(S) URLs and base64 `data:image/...` URLs are supported. Upload availability still depends on the provider/model UI.

## Automatic recovery

Defaults:

```env
AUTO_RECOVER=1
RECOVERY_RETRIES=1
```

Recovery state is tracked independently for every account. Failures before a known prompt submission can be retried after browser repair. A timeout after submission is not blindly resent, avoiding duplicate messages.

## Linux VPS

The included helpers support Debian/Ubuntu-style VPSes:

```bash
bash scripts/vps-setup.sh
bash scripts/vps-display.sh
```

Then install optional systemd services:

```bash
bash scripts/install-systemd.sh
sudo systemctl start gptwrap-display.service
sudo systemctl start gptwrap.service
```

The VPS runs the browser profiles itself. Each named account you intend to use still needs an authenticated provider session. Persistent profiles mean those sessions are reused until the provider requires login/verification again.

For VPS-managed multi-account profiles, leave these empty:

```env
CHROME_USER_DATA_DIR=
CHROME_PROFILE=
```

Pointing at one external Chrome user-data directory is only supported for the `default` account. Separate named accounts need gptwrap's managed profile directories.

For an API used only by software on the same VPS:

```env
HOST=127.0.0.1
```

For network access:

```env
HOST=0.0.0.0
API_KEY=a-long-random-secret
```

Use a firewall/reverse proxy and HTTPS when exposing it beyond localhost.

## Main `.env` options

```env
HOST=127.0.0.1
PORT=3000
API_KEY=

ACCOUNTS={"chatgpt":["default"],"gemini":["default"],"claude":["default"],"grok":["default"],"deepseek":["default"]}
DEFAULT_ACCOUNTS={}
ALLOW_DYNAMIC_ACCOUNTS=0

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

This wrapper depends on consumer web UIs. Selectors, model menus, upload controls, authentication flows, and generated-response containers can change at any time. Multi-account isolation prevents one account's browser state from contaminating another, but it cannot prevent providers from expiring sessions or requesting human verification.

## License

ISC
