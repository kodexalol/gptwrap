// web_models_mvp.js
// ChatGPT + Gemini web UI -> OpenAI-ish API wrapper (single file).
//
// Install:
//   npm init -y
//   npm i express playwright js-tiktoken
//   npx playwright install chromium   (fallback only; real Chrome preferred)
//
// Login once (opens REAL Chrome so Google doesn't flag it):
//   node web_models_mvp.js login gemini
//   node web_models_mvp.js login chatgpt
//
// Run:
//   node web_models_mvp.js
//
// API:
//   POST http://127.0.0.1:3000/v1/chat/completions
//   GET  http://127.0.0.1:3000/health
//   GET  http://127.0.0.1:3000/v1/models
//
// Use only with services/accounts you're authorized to automate.
// Does not bypass CAPTCHAs, limits, or subscriptions.
//
// Why Google said "browser may not be secure":
//   Playwright's bundled Chromium carries automation flags Google rejects.
//   Fix: launch with channel:"chrome" (your real installed Chrome) +
//   strip --enable-automation + hide navigator.webdriver. That's default now.
//
// Reuse your already-logged-in Chrome profile (optional):
//   1. Close ALL Chrome windows (Chrome locks its profile while running).
//   2. set CHROME_USER_DATA_DIR=C:\Users\<you>\AppData\Local\Google\Chrome\User Data
//   3. set CHROME_PROFILE=Default   (or "Profile 1", check chrome://version)
//   4. node web_models_mvp.js login gemini
//   Without these vars, the app uses ./profiles/<provider> (log in once, stays).

const express = require("express");
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

// Tokenizer (cl100k_base approx for web models). Falls back to ~4 chars/token.
let _enc = null;
try {
  _enc = require("js-tiktoken").getEncoding("cl100k_base");
} catch {}
function countTokens(text) {
  const s = String(text || "");
  if (!s) return 0;
  try {
    if (_enc) return _enc.encode(s).length;
  } catch {}
  return Math.ceil(s.length / 4);
}

// ---------- config ----------
const PORT = Number(process.env.PORT || 3000);
const HEADLESS = process.env.HEADLESS === "1"; // keep false for reliability
const PROFILE_ROOT = path.resolve(process.env.PROFILE_ROOT || "./profiles");
const TOOL_ENDPOINT = process.env.TOOL_ENDPOINT || "";
const TOOL_SECRET = process.env.TOOL_SECRET || "";
const MAX_TOOL_LOOPS = Number(process.env.MAX_TOOL_LOOPS || 8);
const TIMEOUT = Number(process.env.TIMEOUT || 180000);

// Real Chrome preferred (fixes Google login). Set USE_REAL_CHROME=0 to force bundled Chromium.
const USE_REAL_CHROME = process.env.USE_REAL_CHROME !== "0";
const CHROME_PATH = process.env.CHROME_PATH || ""; // override binary if needed
// Optional: point at your live Chrome profile to inherit its logins (must close Chrome first).
const CHROME_USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || "";
const CHROME_PROFILE = process.env.CHROME_PROFILE || ""; // e.g. "Default"

// ---------- providers ----------
const PROVIDERS = {
  chatgpt: {
    url: process.env.CHATGPT_URL || "https://chatgpt.com/?temporary-chat=true",
    input: [
      "#prompt-textarea",
      '[data-testid="prompt-textarea"]',
      'div.ProseMirror[contenteditable="true"]',
      'textarea[name="prompt-textarea"]',
      '[contenteditable="true"][role="textbox"]',
    ],
    send: [
      "#composer-submit-button",
      'button[data-testid="send-button"]',
      'button[aria-label*="Send" i]',
      'form button[type="submit"]',
    ],
    assistant: [
      '[data-message-author-role="assistant"]',
      '[data-testid^="conversation-turn-"] .markdown',
      "article[data-testid^='conversation-turn-'] .markdown",
    ],
    generating: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]'],
    cleanup: (t) => String(t || "").replace(/^ChatGPT said:\s*/i, "").trim(),
  },
  gemini: {
    url: process.env.GEMINI_URL || "https://gemini.google.com/app",
    input: [
      "div.ql-editor",
      'rich-textarea [contenteditable="true"]',
      '[aria-label="Enter a prompt here"]',
      '[contenteditable="true"][role="textbox"]',
    ],
    send: [
      'button[aria-label="Send message"]',
      'button[aria-label*="Send" i]',
      ".send-button",
    ],
    assistant: [
      "model-response",
      "message-content",
      ".model-response-text",
      ".response-content",
      ".markdown-main-panel",
    ],
    generating: ['[aria-busy="true"]', 'button[aria-label*="Stop" i]'],
    cleanup: (t) => String(t || "").replace(/^Gemini said\s*/i, "").trim(),
  },
};

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function browserLabel() {
  if (CHROME_USER_DATA_DIR) return `real-chrome-profile (${CHROME_PROFILE || "Default"})`;
  if (USE_REAL_CHROME) return "real-chrome";
  return "bundled-chromium";
}

function getProvider(body) {
  if (body.provider && PROVIDERS[body.provider]) return body.provider;
  if (String(body.model || "").toLowerCase().includes("gemini")) return "gemini";
  return "chatgpt";
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p?.type === "text") return p.text || "";
        if (p?.type === "image_url") return "[image]";
        return JSON.stringify(p);
      })
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

// System/developer messages become a top instruction block (web UI has no
// native system role, so framing it first + highest priority is the fix).
// Also replays prior assistant tool_calls + tool results so multi-turn
// agent loops keep working.
function serializeMessage(m) {
  const text = normalizeContent(m.content);
  if (m.role === "tool") {
    const label = m.name ? `TOOL RESULT FOR ${m.name}` : "TOOL RESULT";
    const id = m.tool_call_id ? ` (${m.tool_call_id})` : "";
    return `${label}${id}:\n${text}`.trim();
  }
  if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
    const calls = m.tool_calls
      .map((c) => {
        const fn = c.function || {};
        const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
        return `{"name":${JSON.stringify(fn.name)}, "arguments":${args}, "id":${JSON.stringify(c.id || "")}}`;
      })
      .join("\n");
    const prior = text ? `${text}\n` : "";
    return `ASSISTANT (previously requested tools):\n${prior}${calls}`.trim();
  }
  const role = String(m.role || "user").toUpperCase();
  return `${role}:\n${text}`.trim();
}

function buildPrompt(messages = []) {
  const systems = messages.filter((m) => m.role === "system" || m.role === "developer");
  const rest = messages.filter((m) => m.role !== "system" && m.role !== "developer");
  const parts = [];
  if (systems.length) {
    const sys = systems.map((m) => normalizeContent(m.content)).filter(Boolean).join("\n\n");
    if (sys) parts.push(`SYSTEM INSTRUCTIONS (highest priority, follow always):\n${sys}`.trim());
  }
  const convo = rest.map(serializeMessage).filter(Boolean).join("\n\n");
  if (convo) parts.push(convo);
  return parts.join("\n\n");
}

// Kept for backwards-compat; now system-aware.
function serializeMessages(messages = []) {
  return buildPrompt(messages);
}

// ---------- tool calling (KODEXA_TOOL protocol) ----------
// toolChoice: "auto" | "none" | "required" | { name } (from OpenAI tool_choice).
function toolChoiceOf(body) {
  const tc = body.tool_choice;
  if (tc == null || tc === "auto") return "auto";
  if (tc === "none") return "none";
  if (tc === "required") return "required";
  if (typeof tc === "object") {
    const fn = tc.function || tc;
    if (fn?.name) return { name: fn.name };
  }
  return "auto";
}

function toolPrompt(tools = [], toolChoice = "auto") {
  if (!tools.length || toolChoice === "none") return "";
  const defs = tools.map((t) => {
    const fn = t.function || t;
    return { name: fn.name, description: fn.description || "", parameters: fn.parameters || { type: "object" } };
  });
  let force = "";
  if (toolChoice === "required") force = "\nYou MUST call one of the tools for this turn.\n";
  else if (typeof toolChoice === "object" && toolChoice.name)
    force = `\nYou MUST call the tool named ${JSON.stringify(toolChoice.name)} for this turn.\n`;
  return `You have access to tools.
TOOLS:
${JSON.stringify(defs, null, 2)}
${force}If you need a tool, output ONLY:
<<<KODEXA_TOOL>>>
{"name":"tool_name","arguments":{"key":"value"}}
<<<END_TOOL>>>
Rules:
- no markdown
- no explanation around tool calls
- valid JSON only
- only use available tools
- otherwise answer normally`.trim();
}

function parseTool(text) {
  const m = String(text || "").match(/<<<KODEXA_TOOL>>>\s*([\s\S]*?)\s*<<<END_TOOL>>>/);
  if (!m) return null;
  try {
    const p = JSON.parse(m[1]);
    if (!p.name || typeof p.name !== "string" || typeof p.arguments !== "object") return null;
    return p;
  } catch {
    return null;
  }
}

const validTool = (call, tools) => tools.some((t) => (t.function || t).name === call.name);

async function executeTool(call) {
  if (!TOOL_ENDPOINT) throw new Error("TOOL_ENDPOINT not configured");
  const headers = { "Content-Type": "application/json" };
  if (TOOL_SECRET) headers.Authorization = `Bearer ${TOOL_SECRET}`;
  const res = await fetch(TOOL_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: call.name, arguments: call.arguments }),
  });
  const raw = await res.text();
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    result = { raw };
  }
  if (!res.ok) throw new Error(`Tool error ${res.status}: ${raw}`);
  return result;
}

// ---------- browser launch (real Chrome, anti-detect) ----------
function profileDirFor(provider) {
  // Reuse live Chrome profile if requested (close Chrome first).
  if (CHROME_USER_DATA_DIR) return path.resolve(CHROME_USER_DATA_DIR);
  return path.join(PROFILE_ROOT, provider);
}

function launchOptions(headless) {
  const opts = {
    headless,
    viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
    ],
  };
  if (CHROME_USER_DATA_DIR && CHROME_PROFILE) opts.args.push(`--profile-directory=${CHROME_PROFILE}`);
  if (CHROME_PATH) opts.executablePath = CHROME_PATH;
  else if (USE_REAL_CHROME) opts.channel = "chrome"; // real installed Chrome
  return opts;
}

async function stealthContext(profileDir, headless) {
  ensureDir(profileDir);
  const opts = launchOptions(headless);
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, opts);
  } catch (err) {
    if (opts.channel || opts.executablePath) {
      console.warn(`[browser] real Chrome failed (${err.message.split("\n")[0]}), falling back to bundled Chromium`);
      const fallback = { ...opts };
      delete fallback.channel;
      delete fallback.executablePath;
      context = await chromium.launchPersistentContext(profileDir, fallback);
    } else {
      throw err;
    }
  }
  // Hide webdriver flag in every page.
  try {
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        window.chrome = window.chrome || { runtime: {} };
        Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      } catch {}
    });
  } catch {}
  return context;
}

// ---------- DOM helpers ----------
async function findVisible(page, selectors, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) return loc;
      } catch {}
    }
    await sleep(200);
  }
  throw new Error(`Could not find UI element.\n${selectors.join("\n")}`);
}

async function anyVisible(page, selectors) {
  for (const sel of selectors) {
    try {
      if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
    } catch {}
  }
  return false;
}

async function getLastResponse(page, provider) {
  const cfg = PROVIDERS[provider];
  for (const sel of cfg.assistant) {
    try {
      const nodes = page.locator(sel);
      const count = await nodes.count();
      for (let i = count - 1; i >= 0; i--) {
        const node = nodes.nth(i);
        if (!(await node.isVisible().catch(() => false))) continue;
        const cleaned = cfg.cleanup(await node.innerText().catch(() => ""));
        if (cleaned) return cleaned;
      }
    } catch {}
  }
  return "";
}

async function setInput(locator, text) {
  try {
    await locator.click({ timeout: 10000 });
  } catch {
    await locator.focus({ timeout: 10000 }).catch(() => {});
  }
  try {
    await locator.fill(text, { timeout: 15000 });
    return;
  } catch {}
  await locator.evaluate((el, value) => {
    el.focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.value = value;
    else el.textContent = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  }, text);
}

async function sendPrompt(page, provider, prompt) {
  const cfg = PROVIDERS[provider];
  const previous = await getLastResponse(page, provider);
  const input = await findVisible(page, cfg.input);
  await setInput(input, prompt);
  await sleep(200);
  let submitted = false;
  for (const sel of cfg.send) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        submitted = true;
        break;
      }
    } catch {}
  }
  if (!submitted) await input.press("Enter");
  return waitForResponse(page, provider, previous);
}

async function waitForResponse(page, provider, previous) {
  const cfg = PROVIDERS[provider];
  const start = Date.now();
  let lastText = previous;
  let stableSince = Date.now();
  let changed = false;
  while (Date.now() - start < TIMEOUT) {
    const current = await getLastResponse(page, provider);
    if (current && current !== previous) changed = true;
    if (current !== lastText) {
      lastText = current;
      stableSince = Date.now();
    }
    const generating = await anyVisible(page, cfg.generating);
    if (changed && current && !generating && Date.now() - stableSince > 1500) return current;
    await sleep(200);
  }
  if (changed && lastText) return lastText;
  throw new Error(`${provider}: response timed out`);
}

// ---------- provider runtime (one persistent page each) ----------
class Runtime {
  constructor(provider) {
    this.provider = provider;
    this.context = null;
    this.page = null;
    this.queue = Promise.resolve();
    this.using = "";
  }
  async start(headless = HEADLESS) {
    if (this.context) return;
    const dir = profileDirFor(this.provider);
    this.context = await stealthContext(dir, headless);
    this.using = browserLabel();
    console.log(`[${this.provider}] browser: ${this.using} | profile: ${dir}`);
  }
  async pageFor() {
    await this.start();
    const wantUrl = PROVIDERS[this.provider].url;
    if (this.page && !this.page.isClosed()) {
      try {
        const cur = this.page.url();
        if (cur && new URL(cur).origin === new URL(wantUrl).origin) return this.page;
      } catch {}
      try {
        await this.page.goto(wantUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        return this.page;
      } catch {}
    }
    this.page = await this.context.newPage();
    await this.page.goto(wantUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    return this.page;
  }
  enqueue(fn) {
    const r = this.queue.then(fn, fn);
    this.queue = r.catch(() => {});
    return r;
  }
  async close() {
    try {
      await this.page?.close().catch(() => {});
    } finally {
      this.page = null;
    }
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
  }
}

const runtimes = { chatgpt: new Runtime("chatgpt"), gemini: new Runtime("gemini") };

// ---------- OpenAI-shaped responses ----------
function makeUsage(promptTokens, completionTokens) {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

const responseObject = (model, content, usage) => ({
  id: `chatcmpl-${Date.now()}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: usage || makeUsage(0, countTokens(content)),
});

const toolResponse = (model, call, usage) => ({
  id: `chatcmpl-${Date.now()}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: `call_${Date.now()}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: usage || makeUsage(0, countTokens(JSON.stringify(call.arguments))),
});

// ---------- completion loop ----------
async function runCompletion(body) {
  const provider = getProvider(body);
  const runtime = runtimes[provider];
  const page = await runtime.pageFor();
  const model = body.model || provider;
  const messages = body.messages || [];
  const tools = body.tools || [];
  const toolChoice = toolChoiceOf(body);

  const toolBlock = toolPrompt(tools, toolChoice);
  const convo = buildPrompt(messages);
  const prompt = [toolBlock, convo].filter(Boolean).join("\n\n");
  let promptTokens = countTokens(prompt);
  const countReply = (t) => countTokens(t);

  let reply = await sendPrompt(page, provider, prompt);
  let completionTokens = countReply(reply);

  for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
    const call = parseTool(reply);
    if (!call) return responseObject(model, reply, makeUsage(promptTokens, completionTokens));
    if (!validTool(call, tools)) throw new Error(`Unknown tool: ${call.name}`);
    // No tool executor configured: hand the call to the OpenAI client.
    if (!TOOL_ENDPOINT)
      return toolResponse(model, call, makeUsage(promptTokens, countReply(JSON.stringify(call))));
    let result;
    try {
      result = await executeTool(call);
    } catch (e) {
      result = { error: e.message };
    }
    const followup = `TOOL RESULT FOR ${call.name}:\n${JSON.stringify(result)}\n\nContinue the original request.\nIf another tool is required, use the exact KODEXA_TOOL format again.\nOtherwise answer normally.`;
    promptTokens += countTokens(followup);
    reply = await sendPrompt(page, provider, followup);
    completionTokens += countReply(reply);
  }
  throw new Error("Maximum tool loops exceeded");
}

// ---------- login ----------
async function login(provider) {
  if (!PROVIDERS[provider]) throw new Error("Use: chatgpt or gemini");
  if (CHROME_USER_DATA_DIR) {
    console.log("Close ALL Chrome windows first (profile is locked while Chrome runs).");
  }
  const dir = profileDirFor(provider);
  console.log(`[${provider}] opening ${browserLabel()} | profile: ${dir}`);
  console.log(`[${provider}] -> ${PROVIDERS[provider].url}`);
  const context = await stealthContext(dir, false); // always visible for login
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(PROVIDERS[provider].url, { waitUntil: "domcontentloaded" });
  console.log(`\nLog into ${provider} in the browser window.`);
  if (provider === "gemini") {
    console.log("If Google blocks login, you used bundled Chromium before — now using real Chrome, retry here.");
    console.log("Still blocked? Close Chrome, set CHROME_USER_DATA_DIR to your Chrome User Data + CHROME_PROFILE=Default, rerun.");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question("\nPress ENTER when logged in... ", resolve));
  rl.close();
  await context.close();
  console.log(`${provider} profile saved -> ${dir}`);
}

// ---------- server ----------
async function startServer() {
  ensureDir(PROFILE_ROOT);
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/health", (req, res) =>
    res.json({ ok: true, providers: ["chatgpt", "gemini"], browser: browserLabel(), toolExecution: Boolean(TOOL_ENDPOINT), tokenizer: _enc ? "cl100k_base" : "fallback" })
  );
  app.get("/v1/models", (req, res) =>
    res.json({ object: "list", data: ["chatgpt", "gemini"].map((id) => ({ id, object: "model", owned_by: id })) })
  );

  app.post("/v1/chat/completions", async (req, res) => {
    const body = req.body || {};
    if (body.stream) return res.status(400).json({ error: { message: "stream:true not supported yet" } });
    const provider = getProvider(body);
    try {
      res.json(await runtimes[provider].enqueue(() => runCompletion(body)));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: { message: e.message, provider } });
    }
  });

  const server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`API running: http://127.0.0.1:${PORT}/v1/chat/completions (${browserLabel()})`);
  });

  const shutdown = async () => {
    console.log("\nShutting down...");
    server.close();
    await runtimes.chatgpt.close();
    await runtimes.gemini.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------- main ----------
async function main() {
  const [command, provider] = process.argv.slice(2);
  if (command === "login") {
    if (provider) await login(provider);
    else {
      await login("gemini");
      await login("chatgpt");
    }
    return;
  }
  await startServer();
}

if (require.main === module) {
  main();
}

// Exported for unit testing (require() without running the server).
module.exports = {
  countTokens,
  normalizeContent,
  buildPrompt,
  serializeMessages,
  serializeMessage,
  toolChoiceOf,
  toolPrompt,
  parseTool,
  validTool,
  makeUsage,
  responseObject,
  toolResponse,
  getProvider,
};
