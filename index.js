// gptwrap
// ChatGPT + Gemini web UI -> OpenAI-compatible-ish API wrapper.
//
// Install:
//   npm i
//   npx playwright install chromium   (fallback only; real Chrome preferred)
//
// Login once:
//   node index.js login gemini
//   node index.js login chatgpt
//
// Run:
//   node index.js
//
// API:
//   POST http://127.0.0.1:3000/v1/chat/completions
//   GET  http://127.0.0.1:3000/health
//   GET  http://127.0.0.1:3000/v1/models
//
// Supports:
//   - OpenAI-style messages/system/developer roles
//   - image_url / input_image content parts (http(s) URLs + data URLs)
//   - live stream:true SSE by polling the web UI as it generates
//   - OpenAI-style tools via the KODEXA_TOOL text protocol
//
// Use only with services/accounts you're authorized to automate.
// Does not bypass CAPTCHAs, limits, subscriptions, or provider controls.

const express = require("express");
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const crypto = require("crypto");

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
const HEADLESS = process.env.HEADLESS === "1";
const PROFILE_ROOT = path.resolve(process.env.PROFILE_ROOT || "./profiles");
const TMP_ROOT = path.resolve(process.env.TMP_ROOT || path.join(PROFILE_ROOT, ".tmp"));
const TOOL_ENDPOINT = process.env.TOOL_ENDPOINT || "";
const TOOL_SECRET = process.env.TOOL_SECRET || "";
const MAX_TOOL_LOOPS = Number(process.env.MAX_TOOL_LOOPS || 8);
const TIMEOUT = Number(process.env.TIMEOUT || 180000);
const BODY_LIMIT = process.env.BODY_LIMIT || "50mb";
const MAX_IMAGES = Number(process.env.MAX_IMAGES || 10);
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 20 * 1024 * 1024);
const STREAM_POLL_MS = Number(process.env.STREAM_POLL_MS || 120);
const STREAM_STABLE_MS = Number(process.env.STREAM_STABLE_MS || 1300);

const USE_REAL_CHROME = process.env.USE_REAL_CHROME !== "0";
const CHROME_PATH = process.env.CHROME_PATH || "";
const CHROME_USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || "";
const CHROME_PROFILE = process.env.CHROME_PROFILE || "";

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
    generating: [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop" i]',
      'button[aria-label*="Stop generating" i]',
    ],
    fileInputs: [
      'input[type="file"][accept*="image"]',
      'input[type="file"][accept*="png"]',
      'input[type="file"]',
    ],
    uploadOpeners: [
      'button[data-testid*="attach" i]',
      'button[aria-label*="Attach" i]',
      'button[aria-label*="Upload" i]',
      'button[aria-label*="Add files" i]',
      'button[aria-label*="Add photos" i]',
    ],
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
    fileInputs: [
      'input[type="file"][accept*="image"]',
      'input[type="file"][accept*="png"]',
      'input[type="file"]',
    ],
    uploadOpeners: [
      'button[aria-label*="Upload" i]',
      'button[aria-label*="Add files" i]',
      'button[aria-label*="Add image" i]',
      'button[aria-label*="Add photo" i]',
      'button[data-test-id*="upload" i]',
    ],
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

function contentPartText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (part.type === "text" || part.type === "input_text") return part.text || "";
  if (part.type === "image_url" || part.type === "input_image") return "[attached image]";
  return JSON.stringify(part);
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentPartText).filter(Boolean).join("\n");
  if (content == null) return "";
  return JSON.stringify(content);
}

function imageSourceFromPart(part) {
  if (!part || typeof part !== "object") return "";
  if (part.type === "image_url") {
    if (typeof part.image_url === "string") return part.image_url;
    if (typeof part.image_url?.url === "string") return part.image_url.url;
  }
  if (part.type === "input_image") {
    if (typeof part.image_url === "string") return part.image_url;
    if (typeof part.image_url?.url === "string") return part.image_url.url;
    if (typeof part.file_data === "string") return part.file_data;
  }
  return "";
}

function extractImages(messages = []) {
  const out = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    if (!Array.isArray(m?.content)) continue;
    for (let pi = 0; pi < m.content.length; pi++) {
      const source = imageSourceFromPart(m.content[pi]);
      if (!source) continue;
      out.push({ source, messageIndex: mi, partIndex: pi });
      if (out.length > MAX_IMAGES) throw new Error(`Too many images: max ${MAX_IMAGES}`);
    }
  }
  return out;
}

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
        return `{"name":${JSON.stringify(fn.name)},"arguments":${args},"id":${JSON.stringify(c.id || "")}}`;
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

function serializeMessages(messages = []) {
  return buildPrompt(messages);
}

// ---------- image handling ----------
const MIME_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function extFromUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return ext === ".jpeg" ? ".jpg" : ext;
  } catch {}
  return "";
}

function parseDataImage(source) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/i.exec(source);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) throw new Error(`Unsupported image type: ${mime}`);
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) throw new Error("Image data URL is empty");
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} byte limit`);
  return { buffer, mime, ext };
}

async function fetchRemoteImage(source) {
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new Error("image_url must be an http(s) URL or base64 data URL");
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`Unsupported image URL protocol: ${url.protocol}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(TIMEOUT, 60000));
  let res;
  try {
    res = await fetch(url, { redirect: "follow", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Failed to fetch image (${res.status})`);

  const length = Number(res.headers.get("content-length") || 0);
  if (length && length > MAX_IMAGE_BYTES) throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} byte limit`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} byte limit`);

  const mime = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = MIME_EXT[mime] || extFromUrl(source);
  if (!ext) throw new Error(`Unsupported or unknown image type: ${mime || "unknown"}`);
  return { buffer, mime: mime || "application/octet-stream", ext };
}

async function materializeImages(images = []) {
  if (!images.length) return [];
  ensureDir(TMP_ROOT);
  const files = [];
  try {
    for (let i = 0; i < images.length; i++) {
      const parsed = parseDataImage(images[i].source) || (await fetchRemoteImage(images[i].source));
      const file = path.join(TMP_ROOT, `img-${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${i}${parsed.ext}`);
      fs.writeFileSync(file, parsed.buffer);
      files.push(file);
    }
    return files;
  } catch (e) {
    cleanupFiles(files);
    throw e;
  }
}

function cleanupFiles(files = []) {
  for (const file of files) {
    try {
      fs.unlinkSync(file);
    } catch {}
  }
}

async function findFileInput(page, provider, timeout = 3000) {
  const cfg = PROVIDERS[provider];
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of cfg.fileInputs || ['input[type="file"]']) {
      try {
        const loc = page.locator(sel);
        const count = await loc.count();
        if (count) return loc.first();
      } catch {}
    }
    await sleep(100);
  }
  return null;
}

async function exposeFileInput(page, provider) {
  let input = await findFileInput(page, provider, 500);
  if (input) return input;
  for (const sel of PROVIDERS[provider].uploadOpeners || []) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        input = await findFileInput(page, provider, 2500);
        if (input) return input;
      }
    } catch {}
  }
  return findFileInput(page, provider, 2500);
}

async function attachImages(page, provider, files = []) {
  if (!files.length) return;
  const input = await exposeFileInput(page, provider);
  if (!input) throw new Error(`${provider}: could not find an image upload input`);

  try {
    await input.setInputFiles(files);
  } catch {
    for (const file of files) {
      const one = await exposeFileInput(page, provider);
      if (!one) throw new Error(`${provider}: image upload input disappeared`);
      await one.setInputFiles(file);
      await sleep(350);
    }
  }
  await sleep(700);
}

// ---------- tool calling (KODEXA_TOOL protocol) ----------
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
  return `You have access to tools.\nTOOLS:\n${JSON.stringify(defs, null, 2)}\n${force}If you need a tool, output ONLY:\n<<<KODEXA_TOOL>>>\n{"name":"tool_name","arguments":{"key":"value"}}\n<<<END_TOOL>>>\nRules:\n- no markdown\n- no explanation around tool calls\n- valid JSON only\n- only use available tools\n- otherwise answer normally`.trim();
}

function parseTool(text) {
  const m = String(text || "").match(/<<<KODEXA_TOOL>>>\s*([\s\S]*?)\s*<<<END_TOOL>>>/);
  if (!m) return null;
  try {
    const p = JSON.parse(m[1]);
    if (!p.name || typeof p.name !== "string" || !p.arguments || typeof p.arguments !== "object") return null;
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

// ---------- browser launch ----------
function profileDirFor(provider) {
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
  else if (USE_REAL_CHROME) opts.channel = "chrome";
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
      console.warn(`[browser] real Chrome failed (${String(err.message).split("\n")[0]}), falling back to bundled Chromium`);
      const fallback = { ...opts };
      delete fallback.channel;
      delete fallback.executablePath;
      context = await chromium.launchPersistentContext(profileDir, fallback);
    } else {
      throw err;
    }
  }
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
    await sleep(180);
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

function deltaFrom(current, emitted) {
  if (!current || current === emitted) return "";
  if (!emitted) return current;
  if (current.startsWith(emitted)) return current.slice(emitted.length);
  return "";
}

async function waitForResponse(page, provider, previous, onDelta = null) {
  const cfg = PROVIDERS[provider];
  const start = Date.now();
  let lastText = previous;
  let stableSince = Date.now();
  let changed = false;
  let emitted = "";

  while (Date.now() - start < TIMEOUT) {
    const current = await getLastResponse(page, provider);
    if (current && current !== previous) changed = true;
    if (current !== lastText) {
      lastText = current;
      stableSince = Date.now();
    }

    if (changed && onDelta && current) {
      const delta = deltaFrom(current, emitted);
      if (delta) {
        onDelta(delta);
        emitted += delta;
      }
    }

    const generating = await anyVisible(page, cfg.generating);
    if (changed && current && !generating && Date.now() - stableSince > STREAM_STABLE_MS) {
      if (onDelta && current.startsWith(emitted) && current.length > emitted.length) onDelta(current.slice(emitted.length));
      return current;
    }
    await sleep(STREAM_POLL_MS);
  }

  if (changed && lastText) {
    if (onDelta && lastText.startsWith(emitted) && lastText.length > emitted.length) onDelta(lastText.slice(emitted.length));
    return lastText;
  }
  throw new Error(`${provider}: response timed out`);
}

async function submitComposer(page, provider, input) {
  const cfg = PROVIDERS[provider];
  for (const sel of cfg.send) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        return;
      }
    } catch {}
  }
  await input.press("Enter");
}

async function sendPrompt(page, provider, prompt, imageFiles = [], onDelta = null) {
  const cfg = PROVIDERS[provider];
  const previous = await getLastResponse(page, provider);
  const input = await findVisible(page, cfg.input);
  if (imageFiles.length) await attachImages(page, provider, imageFiles);
  await setInput(input, prompt);
  await sleep(180);
  await submitComposer(page, provider, input);
  return waitForResponse(page, provider, previous, onDelta);
}

// ---------- provider runtime ----------
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
          {
            id: `call_${Date.now()}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: usage || makeUsage(0, countTokens(JSON.stringify(call.arguments))),
});

// ---------- completion loops ----------
async function completionContext(body) {
  const provider = getProvider(body);
  const runtime = runtimes[provider];
  const page = await runtime.pageFor();
  const model = body.model || provider;
  const messages = body.messages || [];
  const tools = body.tools || [];
  const toolChoice = toolChoiceOf(body);
  const images = extractImages(messages);
  const imageFiles = await materializeImages(images);
  const toolBlock = toolPrompt(tools, toolChoice);
  const convo = buildPrompt(messages);
  const prompt = [toolBlock, convo].filter(Boolean).join("\n\n");
  return { provider, runtime, page, model, messages, tools, toolChoice, imageFiles, prompt };
}

async function runCompletion(body) {
  const ctx = await completionContext(body);
  let promptTokens = countTokens(ctx.prompt);
  let completionTokens = 0;
  try {
    let reply = await sendPrompt(ctx.page, ctx.provider, ctx.prompt, ctx.imageFiles);
    completionTokens += countTokens(reply);

    for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
      const call = parseTool(reply);
      if (!call) return responseObject(ctx.model, reply, makeUsage(promptTokens, completionTokens));
      if (!validTool(call, ctx.tools)) throw new Error(`Unknown tool: ${call.name}`);
      if (!TOOL_ENDPOINT)
        return toolResponse(ctx.model, call, makeUsage(promptTokens, countTokens(JSON.stringify(call))));

      let result;
      try {
        result = await executeTool(call);
      } catch (e) {
        result = { error: e.message };
      }
      const followup = `TOOL RESULT FOR ${call.name}:\n${JSON.stringify(result)}\n\nContinue the original request.\nIf another tool is required, use the exact KODEXA_TOOL format again.\nOtherwise answer normally.`;
      promptTokens += countTokens(followup);
      reply = await sendPrompt(ctx.page, ctx.provider, followup);
      completionTokens += countTokens(reply);
    }
    throw new Error("Maximum tool loops exceeded");
  } finally {
    cleanupFiles(ctx.imageFiles);
  }
}

function sseWrite(res, data) {
  if (res.writableEnded || res.destroyed) return false;
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
  return true;
}

function chunkObject(id, created, model, delta, finishReason = null, usage) {
  const out = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) out.usage = usage;
  return out;
}

async function runCompletionStream(body, res) {
  const ctx = await completionContext(body);
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let promptTokens = countTokens(ctx.prompt);
  let completionTokens = 0;
  let emittedRole = false;
  let emittedContent = "";
  const toolsActive = ctx.tools.length > 0 && ctx.toolChoice !== "none";

  const emitRole = () => {
    if (emittedRole) return;
    emittedRole = true;
    sseWrite(res, chunkObject(id, created, ctx.model, { role: "assistant" }));
  };
  const emitText = (delta) => {
    if (!delta) return;
    emitRole();
    emittedContent += delta;
    sseWrite(res, chunkObject(id, created, ctx.model, { content: delta }));
  };

  try {
    let reply = await sendPrompt(ctx.page, ctx.provider, ctx.prompt, ctx.imageFiles, toolsActive ? null : emitText);
    completionTokens += countTokens(reply);

    for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
      const call = parseTool(reply);
      if (!call) {
        if (toolsActive && !emittedContent) emitText(reply);
        emitRole();
        sseWrite(res, chunkObject(id, created, ctx.model, {}, "stop"));
        if (body.stream_options?.include_usage) {
          sseWrite(res, {
            id,
            object: "chat.completion.chunk",
            created,
            model: ctx.model,
            choices: [],
            usage: makeUsage(promptTokens, completionTokens),
          });
        }
        sseWrite(res, "[DONE]");
        return;
      }

      if (!validTool(call, ctx.tools)) throw new Error(`Unknown tool: ${call.name}`);

      if (!TOOL_ENDPOINT) {
        emitRole();
        const callId = `call_${Date.now()}`;
        sseWrite(
          res,
          chunkObject(id, created, ctx.model, {
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name: call.name, arguments: "" },
              },
            ],
          })
        );
        sseWrite(
          res,
          chunkObject(id, created, ctx.model, {
            tool_calls: [{ index: 0, function: { arguments: JSON.stringify(call.arguments) } }],
          })
        );
        sseWrite(res, chunkObject(id, created, ctx.model, {}, "tool_calls"));
        if (body.stream_options?.include_usage) {
          sseWrite(res, {
            id,
            object: "chat.completion.chunk",
            created,
            model: ctx.model,
            choices: [],
            usage: makeUsage(promptTokens, completionTokens),
          });
        }
        sseWrite(res, "[DONE]");
        return;
      }

      let result;
      try {
        result = await executeTool(call);
      } catch (e) {
        result = { error: e.message };
      }
      const followup = `TOOL RESULT FOR ${call.name}:\n${JSON.stringify(result)}\n\nContinue the original request.\nIf another tool is required, use the exact KODEXA_TOOL format again.\nOtherwise answer normally.`;
      promptTokens += countTokens(followup);
      reply = await sendPrompt(ctx.page, ctx.provider, followup);
      completionTokens += countTokens(reply);
    }
    throw new Error("Maximum tool loops exceeded");
  } finally {
    cleanupFiles(ctx.imageFiles);
  }
}

// ---------- login ----------
async function login(provider) {
  if (!PROVIDERS[provider]) throw new Error("Use: chatgpt or gemini");
  if (CHROME_USER_DATA_DIR) console.log("Close ALL Chrome windows first (profile is locked while Chrome runs).");
  const dir = profileDirFor(provider);
  console.log(`[${provider}] opening ${browserLabel()} | profile: ${dir}`);
  console.log(`[${provider}] -> ${PROVIDERS[provider].url}`);
  const context = await stealthContext(dir, false);
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(PROVIDERS[provider].url, { waitUntil: "domcontentloaded" });
  console.log(`\nLog into ${provider} in the browser window.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question("\nPress ENTER when logged in... ", resolve));
  rl.close();
  await context.close();
  console.log(`${provider} profile saved -> ${dir}`);
}

// ---------- server ----------
async function startServer() {
  ensureDir(PROFILE_ROOT);
  ensureDir(TMP_ROOT);
  const app = express();
  app.use(express.json({ limit: BODY_LIMIT }));

  app.get("/health", (req, res) =>
    res.json({
      ok: true,
      providers: ["chatgpt", "gemini"],
      browser: browserLabel(),
      toolExecution: Boolean(TOOL_ENDPOINT),
      tokenizer: _enc ? "cl100k_base" : "fallback",
      streaming: true,
      images: true,
    })
  );

  app.get("/v1/models", (req, res) =>
    res.json({
      object: "list",
      data: ["chatgpt", "gemini"].map((id) => ({ id, object: "model", owned_by: id })),
    })
  );

  app.post("/v1/chat/completions", async (req, res) => {
    const body = req.body || {};
    const provider = getProvider(body);

    if (body.stream) {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      try {
        await runtimes[provider].enqueue(() => runCompletionStream(body, res));
      } catch (e) {
        console.error(e);
        sseWrite(res, { error: { message: e.message, provider } });
        sseWrite(res, "[DONE]");
      } finally {
        if (!res.writableEnded) res.end();
      }
      return;
    }

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
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  countTokens,
  normalizeContent,
  extractImages,
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
  deltaFrom,
};
