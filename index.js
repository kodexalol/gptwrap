// gptwrap
// Browser-driven OpenAI-compatible-ish wrapper for consumer AI web apps.
// Providers: ChatGPT, Gemini, Claude, Grok, DeepSeek.
//
// Use only with accounts/services you are authorized to automate.
// This does not bypass CAPTCHAs, subscriptions, limits, or provider controls.

const express = require("express");
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const crypto = require("crypto");

// ---------- tiny .env loader (keeps setup dependency-free) ----------
function loadEnvFile(file = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(file)) return;
  try {
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i <= 0) continue;
      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (e) {
    console.warn(`[env] could not read ${file}: ${e.message}`);
  }
}
loadEnvFile();

let _enc = null;
try { _enc = require("js-tiktoken").getEncoding("cl100k_base"); } catch {}

function countTokens(text) {
  const s = String(text || "");
  if (!s) return 0;
  try { if (_enc) return _enc.encode(s).length; } catch {}
  return Math.ceil(s.length / 4);
}

// ---------- config ----------
const HOST = process.env.HOST || "127.0.0.1";
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
const MODEL_STRICT = process.env.MODEL_STRICT === "1";
const MODEL_SELECT_TIMEOUT = Number(process.env.MODEL_SELECT_TIMEOUT || 6500);
const MODEL_MAP_RAW = process.env.MODEL_MAP || "";
const MODEL_DISCOVERY_TTL_MS = Number(process.env.MODEL_DISCOVERY_TTL_MS || 10 * 60 * 1000);
const AUTO_DISCOVER_MODELS = process.env.AUTO_DISCOVER_MODELS !== "0";
const AUTO_RECOVER = process.env.AUTO_RECOVER !== "0";
const RECOVERY_RETRIES = Math.max(0, Number(process.env.RECOVERY_RETRIES || 1));
const USE_REAL_CHROME = process.env.USE_REAL_CHROME !== "0";
const CHROME_PATH = process.env.CHROME_PATH || "";
const CHROME_USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || "";
const CHROME_PROFILE = process.env.CHROME_PROFILE || "";
const NO_SANDBOX = process.env.NO_SANDBOX === "1";
const API_KEY = process.env.API_KEY || "";
const ALLOW_UNAUTHENTICATED = process.env.ALLOW_UNAUTHENTICATED === "1";

const COMMON_FILE_INPUTS = [
  'input[type="file"][accept*="image"]',
  'input[type="file"][accept*="png"]',
  'input[type="file"]',
];
const COMMON_UPLOAD_OPENERS = [
  'button[aria-label*="Attach" i]',
  'button[aria-label*="Upload" i]',
  'button[aria-label*="Add file" i]',
  'button[aria-label*="Add photo" i]',
  'button[aria-label*="Add image" i]',
  'button[title*="Attach" i]',
  'button[title*="Upload" i]',
];
const COMMON_MODEL_OPENERS = [
  'button[data-testid*="model" i]',
  'button[aria-label*="model" i][aria-haspopup]',
  '[role="button"][aria-label*="model" i][aria-haspopup]',
  'button[aria-haspopup="listbox"]',
  'button[aria-haspopup="menu"]',
];
const COMMON_SEND = [
  'button[data-testid*="send" i]',
  'button[aria-label*="Send" i]',
  'button[type="submit"]',
];
const COMMON_INPUT = [
  'textarea[placeholder*="message" i]',
  'textarea[placeholder*="ask" i]',
  'textarea',
  'div.ProseMirror[contenteditable="true"]',
  '[contenteditable="true"][role="textbox"]',
];
const COMMON_ASSISTANT = [
  '[data-message-author-role="assistant"]',
  '[data-testid*="assistant" i]',
  'main article [class*="markdown"]',
  'main article [class*="prose"]',
  'main [class*="markdown"]',
  'main [class*="prose"]',
];
const COMMON_GENERATING = [
  'button[aria-label*="Stop" i]',
  'button[data-testid*="stop" i]',
  '[aria-busy="true"]',
];

const BASE_CAPABILITIES = Object.freeze({
  chat_completions: true,
  streaming: true,
  tool_calling: true,
  image_input: true,
  model_selection: true,
  model_discovery: true,
});

// ---------- providers ----------
const PROVIDERS = {
  chatgpt: {
    title: "ChatGPT",
    url: process.env.CHATGPT_URL || "https://chatgpt.com/?temporary-chat=true",
    capabilities: { ...BASE_CAPABILITIES },
    input: [
      "#prompt-textarea",
      '[data-testid="prompt-textarea"]',
      'div.ProseMirror[contenteditable="true"]',
      'textarea[name="prompt-textarea"]',
      ...COMMON_INPUT,
    ],
    send: ["#composer-submit-button", 'button[data-testid="send-button"]', ...COMMON_SEND],
    assistant: [
      '[data-message-author-role="assistant"]',
      '[data-testid^="conversation-turn-"] .markdown',
      "article[data-testid^='conversation-turn-'] .markdown",
      ...COMMON_ASSISTANT,
    ],
    generating: [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop generating" i]',
      ...COMMON_GENERATING,
    ],
    fileInputs: COMMON_FILE_INPUTS,
    uploadOpeners: ['button[data-testid*="attach" i]', ...COMMON_UPLOAD_OPENERS],
    modelOpeners: [
      'button[data-testid="model-switcher-dropdown-button"]',
      'button[data-testid*="model-switcher" i]',
      ...COMMON_MODEL_OPENERS,
    ],
    discoveryKeywords: ["gpt", "instant", "thinking", "think", "pro", "luna", "sol", "o1", "o3", "o4"],
    cleanup: (t) => String(t || "").replace(/^ChatGPT said:\s*/i, "").trim(),
  },

  gemini: {
    title: "Gemini",
    url: process.env.GEMINI_URL || "https://gemini.google.com/app",
    capabilities: { ...BASE_CAPABILITIES },
    input: [
      "div.ql-editor",
      'rich-textarea [contenteditable="true"]',
      '[aria-label="Enter a prompt here"]',
      ...COMMON_INPUT,
    ],
    send: ['button[aria-label="Send message"]', ".send-button", ...COMMON_SEND],
    assistant: [
      "model-response",
      "message-content",
      ".model-response-text",
      ".response-content",
      ".markdown-main-panel",
      ...COMMON_ASSISTANT,
    ],
    generating: COMMON_GENERATING,
    fileInputs: COMMON_FILE_INPUTS,
    uploadOpeners: COMMON_UPLOAD_OPENERS,
    modelOpeners: COMMON_MODEL_OPENERS,
    discoveryKeywords: ["gemini", "flash", "pro", "fast", "thinking", "deep think"],
    cleanup: (t) => String(t || "").replace(/^Gemini said\s*/i, "").trim(),
  },

  claude: {
    title: "Claude",
    url: process.env.CLAUDE_URL || "https://claude.ai/new",
    capabilities: { ...BASE_CAPABILITIES },
    input: [
      'div.ProseMirror[contenteditable="true"]',
      '[data-testid*="composer" i] [contenteditable="true"]',
      '[contenteditable="true"][data-placeholder]',
      ...COMMON_INPUT,
    ],
    send: ['button[aria-label*="Send message" i]', 'button[data-testid*="send" i]', ...COMMON_SEND],
    assistant: [
      '[data-testid*="assistant" i]',
      '[data-is-streaming] [class*="font"]',
      ".font-claude-response",
      'main [class*="prose"]',
      ...COMMON_ASSISTANT,
    ],
    generating: ['[data-is-streaming="true"]', ...COMMON_GENERATING],
    fileInputs: COMMON_FILE_INPUTS,
    uploadOpeners: ['button[aria-label*="Add content" i]', 'button[aria-label*="Attach" i]', ...COMMON_UPLOAD_OPENERS],
    modelOpeners: ['button[data-testid*="model" i]', 'button[aria-label*="model" i]', ...COMMON_MODEL_OPENERS],
    discoveryKeywords: ["claude", "sonnet", "opus", "haiku", "fable"],
    cleanup: (t) => String(t || "").replace(/^Claude(?: said)?:?\s*/i, "").trim(),
  },

  grok: {
    title: "Grok",
    url: process.env.GROK_URL || "https://grok.com/",
    capabilities: { ...BASE_CAPABILITIES },
    input: [
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder*="Grok" i]',
      '[contenteditable="true"][role="textbox"]',
      ...COMMON_INPUT,
    ],
    send: ['button[aria-label*="Submit" i]', 'button[aria-label*="Send" i]', ...COMMON_SEND],
    assistant: [
      '[data-testid*="assistant" i]',
      '[data-message-author-role="assistant"]',
      'main article [class*="markdown"]',
      'main [class*="prose"]',
      ...COMMON_ASSISTANT,
    ],
    generating: COMMON_GENERATING,
    fileInputs: COMMON_FILE_INPUTS,
    uploadOpeners: ['button[aria-label*="Attach" i]', 'button[aria-label*="Add" i]', ...COMMON_UPLOAD_OPENERS],
    modelOpeners: ['button[aria-label*="model" i]', 'button[data-testid*="model" i]', ...COMMON_MODEL_OPENERS],
    discoveryKeywords: ["grok", "reasoning", "thinking", "think", "fast"],
    cleanup: (t) => String(t || "").replace(/^Grok(?: said)?:?\s*/i, "").trim(),
  },

  deepseek: {
    title: "DeepSeek",
    url: process.env.DEEPSEEK_URL || "https://chat.deepseek.com/",
    capabilities: { ...BASE_CAPABILITIES },
    input: [
      "#chat-input",
      'textarea[placeholder*="Message" i]',
      'textarea[placeholder*="DeepSeek" i]',
      '[contenteditable="true"][role="textbox"]',
      ...COMMON_INPUT,
    ],
    send: ['button[aria-label*="Send" i]', 'button[class*="send" i]', ...COMMON_SEND],
    assistant: [
      '[data-role="assistant"]',
      '[data-message-author-role="assistant"]',
      ".ds-markdown",
      'main [class*="markdown"]',
      ...COMMON_ASSISTANT,
    ],
    generating: COMMON_GENERATING,
    fileInputs: COMMON_FILE_INPUTS,
    uploadOpeners: ['button[aria-label*="Upload" i]', 'button[aria-label*="Attach" i]', ...COMMON_UPLOAD_OPENERS],
    modelOpeners: ['button[aria-label*="mode" i]', 'button[aria-label*="model" i]', ...COMMON_MODEL_OPENERS],
    discoveryKeywords: ["deepseek", "v4", "instant", "expert", "vision", "reasoner", "chat"],
    cleanup: (t) => String(t || "").replace(/^DeepSeek(?: said)?:?\s*/i, "").trim(),
  },
};

const PROVIDER_NAMES = Object.keys(PROVIDERS);

// ---------- model routing ----------
const DEFAULT_MODEL_MAP = {
  chatgpt: { provider: "chatgpt", uiLabels: [], selectable: false },
  "chatgpt-auto": { provider: "chatgpt", uiLabels: [], selectable: false },
  "gpt-5.6": { provider: "chatgpt", uiLabels: ["GPT-5.6", "GPT 5.6"] },
  "gpt-5.6-sol": { provider: "chatgpt", uiLabels: ["GPT-5.6 Sol", "GPT 5.6 Sol", "Sol"] },
  "gpt-5.6-luna": { provider: "chatgpt", uiLabels: ["GPT-5.6 Luna", "GPT 5.6 Luna", "Luna"] },
  "gpt-5.6-pro": { provider: "chatgpt", uiLabels: ["GPT-5.6 Pro", "GPT 5.6 Pro", "Pro"] },
  "chatgpt-instant": { provider: "chatgpt", uiLabels: ["Instant"] },
  "chatgpt-thinking": { provider: "chatgpt", uiLabels: ["Thinking", "Think"] },

  gemini: { provider: "gemini", uiLabels: [], selectable: false },
  "gemini-auto": { provider: "gemini", uiLabels: [], selectable: false },
  "gemini-fast": { provider: "gemini", uiLabels: ["Fast"] },
  "gemini-pro": { provider: "gemini", uiLabels: ["Pro"] },
  "gemini-thinking": { provider: "gemini", uiLabels: ["Thinking", "Deep Think"] },

  claude: { provider: "claude", uiLabels: [], selectable: false },
  "claude-auto": { provider: "claude", uiLabels: [], selectable: false },
  "claude-sonnet-5": { provider: "claude", uiLabels: ["Sonnet 5", "Claude Sonnet 5"] },
  "claude-opus-5": { provider: "claude", uiLabels: ["Opus 5", "Claude Opus 5"] },
  "claude-fable-5": { provider: "claude", uiLabels: ["Fable 5", "Claude Fable 5"] },
  "claude-fable-5.1": { provider: "claude", uiLabels: ["Fable 5.1", "Claude Fable 5.1"] },
  "claude-haiku-4.5": { provider: "claude", uiLabels: ["Haiku 4.5", "Claude Haiku 4.5"] },

  grok: { provider: "grok", uiLabels: [], selectable: false },
  "grok-auto": { provider: "grok", uiLabels: [], selectable: false },
  "grok-4.6": { provider: "grok", uiLabels: ["Grok 4.6", "4.6"] },
  "grok-4.5": { provider: "grok", uiLabels: ["Grok 4.5", "4.5"] },
  "grok-4.3": { provider: "grok", uiLabels: ["Grok 4.3", "4.3"] },
  "grok-reasoning": { provider: "grok", uiLabels: ["Reasoning", "Think", "Thinking"] },

  deepseek: { provider: "deepseek", uiLabels: [], selectable: false },
  "deepseek-auto": { provider: "deepseek", uiLabels: [], selectable: false },
  "deepseek-instant": { provider: "deepseek", uiLabels: ["Instant", "Instant Mode"] },
  "deepseek-expert": { provider: "deepseek", uiLabels: ["Expert", "Expert Mode"] },
  "deepseek-vision": { provider: "deepseek", uiLabels: ["Vision", "Vision Mode"] },
  "deepseek-v4-flash": { provider: "deepseek", uiLabels: ["V4 Flash", "DeepSeek V4 Flash", "Instant"] },
  "deepseek-v4-pro": { provider: "deepseek", uiLabels: ["V4 Pro", "DeepSeek V4 Pro", "Expert"] },
};

function uniqueStrings(values) {
  return [...new Set((values || []).map((v) => String(v || "").trim()).filter(Boolean))];
}

function inferProviderFromModel(model) {
  const s = String(model || "").trim().toLowerCase();
  for (const p of PROVIDER_NAMES) {
    if (s === p || s.startsWith(`${p}:`) || s.startsWith(`${p}/`) || s.startsWith(`${p}-`)) return p;
  }
  if (s.startsWith("gpt-") || /^o\d/.test(s) || s.includes("chatgpt")) return "chatgpt";
  if (s.includes("gemini")) return "gemini";
  if (s.includes("claude") || s.includes("sonnet") || s.includes("opus") || s.includes("haiku") || s.includes("fable")) return "claude";
  if (s.includes("grok")) return "grok";
  if (s.includes("deepseek")) return "deepseek";
  return "chatgpt";
}

function parseCustomModelMap(raw) {
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    console.warn(`[models] MODEL_MAP invalid JSON: ${e.message}`);
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn("[models] MODEL_MAP must be a JSON object");
    return {};
  }

  const out = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      out[id.toLowerCase()] = { provider: inferProviderFromModel(id), uiLabels: [value], selectable: true };
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const provider = PROVIDERS[value.provider] ? value.provider : inferProviderFromModel(id);
    const labels = uniqueStrings([
      ...(Array.isArray(value.uiLabels) ? value.uiLabels : []),
      ...(Array.isArray(value.labels) ? value.labels : []),
      value.uiLabel, value.label,
    ]);
    out[id.toLowerCase()] = {
      provider,
      uiLabels: labels,
      selectable: value.selectable !== false && labels.length > 0,
    };
  }
  return out;
}

const MODEL_MAP = { ...DEFAULT_MODEL_MAP, ...parseCustomModelMap(MODEL_MAP_RAW) };
const DISCOVERED_MODEL_MAP = {};
const DISCOVERY_CACHE = new Map();

function stripProviderPrefix(model) {
  const raw = String(model || "").trim();
  const names = PROVIDER_NAMES.join("|");
  return raw.replace(new RegExp(`^(${names})[:/]`, "i"), "");
}
function modelLabelGuesses(model) {
  const raw = stripProviderPrefix(model);
  if (!raw) return [];
  const spaced = raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const title = spaced.replace(/\b([a-z])/g, (m) => m.toUpperCase());
  return uniqueStrings([raw, spaced, title]);
}
function resolveModel(model) {
  const requested = String(model || "chatgpt").trim() || "chatgpt";
  const key = requested.toLowerCase();
  const known = DISCOVERED_MODEL_MAP[key] || MODEL_MAP[key];
  if (known) {
    const labels = uniqueStrings(known.uiLabels || []);
    return {
      id: requested, key, provider: known.provider, uiLabels: labels,
      selectable: known.selectable !== false && labels.length > 0,
      known: true, discovered: Boolean(known.discovered),
    };
  }
  const provider = inferProviderFromModel(requested);
  const uiLabels = modelLabelGuesses(requested);
  return { id: requested, key, provider, uiLabels, selectable: uiLabels.length > 0, known: false, discovered: false };
}
function modelCapabilities(provider) {
  return { ...(PROVIDERS[provider]?.capabilities || BASE_CAPABILITIES) };
}
function publicModels(providerFilter = "") {
  const entries = new Map();
  for (const [id, cfg] of Object.entries(MODEL_MAP)) entries.set(id, { id, cfg });
  for (const [id, cfg] of Object.entries(DISCOVERED_MODEL_MAP)) entries.set(id, { id, cfg });
  return [...entries.values()]
    .filter(({ cfg }) => !providerFilter || cfg.provider === providerFilter)
    .map(({ id, cfg }) => ({
      id,
      object: "model",
      owned_by: cfg.provider,
      provider: cfg.provider,
      selectable: cfg.selectable !== false && (cfg.uiLabels || []).length > 0,
      discovered: Boolean(cfg.discovered),
      label: cfg.label || undefined,
      capabilities: modelCapabilities(cfg.provider),
    }));
}

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function browserLabel() {
  if (CHROME_USER_DATA_DIR) return `real-chrome-profile (${CHROME_PROFILE || "Default"})`;
  if (CHROME_PATH) return `custom-chrome (${CHROME_PATH})`;
  if (USE_REAL_CHROME) return "real-chrome";
  return "bundled-chromium";
}
function getProvider(body) {
  const explicit = String(body?.provider || "").toLowerCase();
  if (PROVIDERS[explicit]) return explicit;
  return resolveModel(body?.model).provider;
}
function isLoopbackHost(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(String(host).toLowerCase());
}
function timingSafeStringEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function requestApiKey(req) {
  const auth = String(req.headers.authorization || "");
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return String(req.headers["x-api-key"] || "").trim();
}
function authMiddleware(req, res, next) {
  if (!API_KEY) return next();
  if (timingSafeStringEqual(requestApiKey(req), API_KEY)) return next();
  res.status(401).json({
    error: {
      message: "Invalid or missing API key",
      type: "authentication_error",
    },
  });
}
function markError(err, { safeToRetry, stage } = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  if (safeToRetry !== undefined) e.safeToRetry = safeToRetry;
  if (stage) e.stage = stage;
  return e;
}
function shouldRetryError(err) {
  if (err?.safeToRetry === true) return true;
  if (err?.safeToRetry === false) return false;
  return /Could not find UI element|Target page.*closed|Target closed|Execution context was destroyed|frame was detached|net::ERR_|Navigation failed/i
    .test(String(err?.message || err || ""));
}

// ---------- message/content ----------
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
    const calls = m.tool_calls.map((c) => {
      const fn = c.function || {};
      const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
      return `{"name":${JSON.stringify(fn.name)},"arguments":${args},"id":${JSON.stringify(c.id || "")}}`;
    }).join("\n");
    return `ASSISTANT (previously requested tools):\n${text ? `${text}\n` : ""}${calls}`.trim();
  }
  return `${String(m.role || "user").toUpperCase()}:\n${text}`.trim();
}
function buildPrompt(messages = []) {
  const systems = messages.filter((m) => m.role === "system" || m.role === "developer");
  const rest = messages.filter((m) => m.role !== "system" && m.role !== "developer");
  const parts = [];
  const sys = systems.map((m) => normalizeContent(m.content)).filter(Boolean).join("\n\n");
  if (sys) parts.push(`SYSTEM INSTRUCTIONS (highest priority, follow always):\n${sys}`);
  const convo = rest.map(serializeMessage).filter(Boolean).join("\n\n");
  if (convo) parts.push(convo);
  return parts.join("\n\n");
}
const serializeMessages = buildPrompt;

// ---------- image handling ----------
const MIME_EXT = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg",
  "image/webp": ".webp", "image/gif": ".gif",
};
function extFromUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return ext === ".jpeg" ? ".jpg" : ext;
  } catch {}
  return "";
}
function parseDataImage(source) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/i.exec(source);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) throw new Error(`Unsupported image type: ${mime}`);
  const buffer = Buffer.from(m[2], "base64");
  if (!buffer.length) throw new Error("Image data URL is empty");
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} byte limit`);
  return { buffer, mime, ext };
}
async function fetchRemoteImage(source) {
  let url;
  try { url = new URL(source); } catch { throw new Error("image_url must be http(s) or a base64 data URL"); }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`Unsupported image URL protocol: ${url.protocol}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(TIMEOUT, 60000));
  let res;
  try { res = await fetch(url, { redirect: "follow", signal: controller.signal }); }
  finally { clearTimeout(timer); }
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
      const parsed = parseDataImage(images[i].source) || await fetchRemoteImage(images[i].source);
      const file = path.join(TMP_ROOT, `img-${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${i}${parsed.ext}`);
      fs.writeFileSync(file, parsed.buffer);
      files.push(file);
    }
    return files;
  } catch (e) { cleanupFiles(files); throw e; }
}
function cleanupFiles(files = []) {
  for (const file of files) { try { fs.unlinkSync(file); } catch {} }
}

// ---------- tools ----------
function toolChoiceOf(body) {
  const tc = body.tool_choice;
  if (tc == null || tc === "auto") return "auto";
  if (tc === "none" || tc === "required") return tc;
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
  else if (typeof toolChoice === "object" && toolChoice.name) force = `\nYou MUST call ${JSON.stringify(toolChoice.name)} for this turn.\n`;
  return `You have access to tools.\nTOOLS:\n${JSON.stringify(defs, null, 2)}\n${force}If you need a tool, output ONLY:\n<<<KODEXA_TOOL>>>\n{"name":"tool_name","arguments":{"key":"value"}}\n<<<END_TOOL>>>\nRules:\n- no markdown around tool calls\n- valid JSON only\n- only use available tools\n- otherwise answer normally`;
}
function parseTool(text) {
  const m = String(text || "").match(/<<<KODEXA_TOOL>>>\s*([\s\S]*?)\s*<<<END_TOOL>>>/);
  if (!m) return null;
  try {
    const p = JSON.parse(m[1]);
    if (!p.name || typeof p.name !== "string" || !p.arguments || typeof p.arguments !== "object") return null;
    return p;
  } catch { return null; }
}
const validTool = (call, tools) => tools.some((t) => (t.function || t).name === call.name);
async function executeTool(call) {
  if (!TOOL_ENDPOINT) throw new Error("TOOL_ENDPOINT not configured");
  const headers = { "Content-Type": "application/json" };
  if (TOOL_SECRET) headers.Authorization = `Bearer ${TOOL_SECRET}`;
  const res = await fetch(TOOL_ENDPOINT, {
    method: "POST", headers, body: JSON.stringify({ name: call.name, arguments: call.arguments }),
  });
  const raw = await res.text();
  let result;
  try { result = JSON.parse(raw); } catch { result = { raw }; }
  if (!res.ok) throw new Error(`Tool error ${res.status}: ${raw}`);
  return result;
}

// ---------- browser ----------
function profileDirFor(provider) {
  if (CHROME_USER_DATA_DIR) return path.resolve(CHROME_USER_DATA_DIR);
  return path.join(PROFILE_ROOT, provider);
}
function launchOptions(headless) {
  if (process.platform === "linux" && !headless && !process.env.DISPLAY) {
    throw new Error("No DISPLAY is available. On a Linux VPS run scripts/vps-display.sh and set DISPLAY=:99, or use HEADLESS=1 after logging in.");
  }
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
  if (NO_SANDBOX) opts.args.push("--no-sandbox", "--disable-setuid-sandbox");
  if (CHROME_USER_DATA_DIR && CHROME_PROFILE) opts.args.push(`--profile-directory=${CHROME_PROFILE}`);
  if (CHROME_PATH) opts.executablePath = CHROME_PATH;
  else if (USE_REAL_CHROME) opts.channel = "chrome";
  return opts;
}
async function stealthContext(profileDir, headless) {
  ensureDir(profileDir);
  const opts = launchOptions(headless);
  let context;
  try { context = await chromium.launchPersistentContext(profileDir, opts); }
  catch (err) {
    if (!(opts.channel || opts.executablePath)) throw err;
    console.warn(`[browser] configured Chrome failed (${String(err.message).split("\n")[0]}), falling back to bundled Chromium`);
    const fallback = { ...opts };
    delete fallback.channel; delete fallback.executablePath;
    context = await chromium.launchPersistentContext(profileDir, fallback);
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

// ---------- DOM ----------
async function findVisible(page, selectors, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of uniqueStrings(selectors)) {
      try {
        const nodes = page.locator(sel);
        const count = Math.min(await nodes.count(), 5);
        for (let i = 0; i < count; i++) {
          const loc = nodes.nth(i);
          if (await loc.isVisible().catch(() => false)) return loc;
        }
      } catch {}
    }
    await sleep(180);
  }
  throw markError(new Error(`Could not find UI element.\n${uniqueStrings(selectors).join("\n")}`), { safeToRetry: true, stage: "prepare" });
}
async function anyVisible(page, selectors) {
  for (const sel of uniqueStrings(selectors)) {
    try {
      const nodes = page.locator(sel);
      const count = Math.min(await nodes.count(), 4);
      for (let i = 0; i < count; i++) if (await nodes.nth(i).isVisible().catch(() => false)) return true;
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
      for (let i = count - 1; i >= Math.max(0, count - 8); i--) {
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
  try { await locator.click({ timeout: 10000 }); } catch { await locator.focus({ timeout: 10000 }).catch(() => {}); }
  try { await locator.fill(text, { timeout: 15000 }); return; } catch {}
  await locator.evaluate((el, value) => {
    el.focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.value = value;
    else el.textContent = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  }, text);
}
async function findFileInput(page, provider, timeout = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of PROVIDERS[provider].fileInputs || COMMON_FILE_INPUTS) {
      try {
        const loc = page.locator(sel);
        if (await loc.count()) return loc.first();
      } catch {}
    }
    await sleep(100);
  }
  return null;
}
async function exposeFileInput(page, provider) {
  let input = await findFileInput(page, provider, 400);
  if (input) return input;
  for (const sel of PROVIDERS[provider].uploadOpeners || []) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        input = await findFileInput(page, provider, 2200);
        if (input) return input;
      }
    } catch {}
  }
  return findFileInput(page, provider, 2000);
}
async function attachImages(page, provider, files = []) {
  if (!files.length) return;
  const input = await exposeFileInput(page, provider);
  if (!input) throw markError(new Error(`${provider}: could not find image/file upload input`), { safeToRetry: true, stage: "prepare" });
  try { await input.setInputFiles(files); }
  catch {
    for (const file of files) {
      const one = await exposeFileInput(page, provider);
      if (!one) throw markError(new Error(`${provider}: upload input disappeared`), { safeToRetry: true, stage: "prepare" });
      await one.setInputFiles(file);
      await sleep(350);
    }
  }
  await sleep(700);
}
async function clickTextOption(page, labels) {
  for (const label of labels) {
    const safe = String(label).trim();
    if (!safe) continue;
    const candidates = [
      page.getByRole("option", { name: safe, exact: true }),
      page.getByRole("menuitem", { name: safe, exact: true }),
      page.getByRole("radio", { name: safe, exact: true }),
      page.getByRole("button", { name: safe, exact: true }),
      page.getByText(safe, { exact: true }),
    ];
    for (const loc of candidates) {
      try {
        const first = loc.first();
        if (await first.isVisible({ timeout: 250 }).catch(() => false)) {
          await first.click();
          return safe;
        }
      } catch {}
    }
  }
  return "";
}
async function selectModel(page, runtime, requestedModel) {
  const model = resolveModel(requestedModel);
  if (model.provider !== runtime.provider) {
    throw markError(new Error(`Model ${JSON.stringify(requestedModel)} belongs to ${model.provider}, not ${runtime.provider}`), { safeToRetry: false, stage: "prepare" });
  }
  if (!model.selectable) return { selected: false, skipped: true, model };
  if (runtime.selectedModelKey === model.key) return { selected: true, cached: true, model };

  const cfg = PROVIDERS[runtime.provider];
  const start = Date.now();
  let selected = "";
  while (Date.now() - start < MODEL_SELECT_TIMEOUT && !selected) {
    for (const sel of cfg.modelOpeners || []) {
      try {
        const opener = page.locator(sel).first();
        if (!(await opener.isVisible().catch(() => false))) continue;
        await opener.click();
        await sleep(180);
        selected = await clickTextOption(page, model.uiLabels);
        if (selected) break;
        await page.keyboard.press("Escape").catch(() => {});
      } catch {}
    }
    if (!selected) {
      selected = await clickTextOption(page, model.uiLabels);
      if (!selected) await sleep(200);
    }
  }

  if (!selected) {
    const msg = `${runtime.provider}: could not select ${JSON.stringify(requestedModel)}; tried ${model.uiLabels.join(", ")}`;
    if (MODEL_STRICT) throw markError(new Error(msg), { safeToRetry: true, stage: "prepare" });
    console.warn(`[models] ${msg}; continuing with current UI model`);
    return { selected: false, model };
  }
  runtime.selectedModelKey = model.key;
  runtime.selectedModelLabel = selected;
  console.log(`[${runtime.provider}] model -> ${selected}`);
  return { selected: true, label: selected, model };
}

function normalizeModelLabel(s) {
  return String(s || "").toLowerCase().replace(/[^\p{L}\p{N}.]+/gu, " ").replace(/\s+/g, " ").trim();
}
function slugifyModelLabel(label) {
  return normalizeModelLabel(label).replace(/\s+/g, "-").replace(/[^a-z0-9.-]/g, "").replace(/^-+|-+$/g, "") || "model";
}
function looksLikeModelLabel(provider, text) {
  const s = normalizeModelLabel(text);
  if (!s || s.length < 2 || s.length > 80) return false;
  const cfg = PROVIDERS[provider];
  return (cfg.discoveryKeywords || []).some((k) => s.includes(normalizeModelLabel(k)));
}
async function visibleTextCandidates(page) {
  const selectors = [
    '[role="option"]',
    '[role="menuitem"]',
    '[role="radio"]',
    '[data-testid*="model" i]',
    '[aria-label*="model" i]',
    '[aria-label*="thinking" i]',
    '[aria-label*="reasoning" i]',
  ];
  const out = [];
  for (const sel of selectors) {
    try {
      const nodes = page.locator(sel);
      const count = Math.min(await nodes.count(), 60);
      for (let i = 0; i < count; i++) {
        const node = nodes.nth(i);
        if (!(await node.isVisible().catch(() => false))) continue;
        const text = String(await node.innerText().catch(() => "")).trim();
        const aria = String(await node.getAttribute("aria-label").catch(() => "") || "").trim();
        if (text) out.push(text);
        if (aria) out.push(aria);
      }
    } catch {}
  }
  return uniqueStrings(out);
}
function registerDiscoveredModels(provider, labels) {
  const models = [];
  const used = new Set();
  for (const label of labels) {
    if (!looksLikeModelLabel(provider, label)) continue;
    const normalized = normalizeModelLabel(label);
    if (used.has(normalized)) continue;
    used.add(normalized);
    const id = `${provider}/${slugifyModelLabel(label)}`;
    const cfg = {
      provider,
      uiLabels: [label],
      selectable: true,
      discovered: true,
      label,
    };
    DISCOVERED_MODEL_MAP[id.toLowerCase()] = cfg;
    models.push({
      id,
      object: "model",
      owned_by: provider,
      provider,
      selectable: true,
      discovered: true,
      label,
      capabilities: modelCapabilities(provider),
    });
  }
  return models;
}
async function discoverModelsOnPage(page, provider, { force = false } = {}) {
  const cached = DISCOVERY_CACHE.get(provider);
  if (!force && cached && Date.now() - cached.at < MODEL_DISCOVERY_TTL_MS) return cached.models;

  const cfg = PROVIDERS[provider];
  let labels = [];
  for (const sel of cfg.modelOpeners || []) {
    try {
      const openers = page.locator(sel);
      const count = Math.min(await openers.count(), 4);
      for (let i = 0; i < count; i++) {
        const opener = openers.nth(i);
        if (!(await opener.isVisible().catch(() => false))) continue;
        await opener.click();
        await sleep(250);
        labels.push(...await visibleTextCandidates(page));
        await page.keyboard.press("Escape").catch(() => {});
        if (labels.some((x) => looksLikeModelLabel(provider, x))) break;
      }
    } catch {}
    if (labels.some((x) => looksLikeModelLabel(provider, x))) break;
  }

  labels = uniqueStrings(labels).filter((x) => looksLikeModelLabel(provider, x));
  const models = registerDiscoveredModels(provider, labels);
  DISCOVERY_CACHE.set(provider, { at: Date.now(), models });
  return models;
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
  let lastText = previous, stableSince = Date.now(), changed = false, emitted = "";
  while (Date.now() - start < TIMEOUT) {
    const current = await getLastResponse(page, provider);
    if (current && current !== previous) changed = true;
    if (current !== lastText) { lastText = current; stableSince = Date.now(); }
    if (changed && onDelta && current) {
      const delta = deltaFrom(current, emitted);
      if (delta) { onDelta(delta); emitted += delta; }
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
  throw markError(new Error(`${provider}: response timed out`), { safeToRetry: false, stage: "response" });
}
async function submitComposer(page, provider, input) {
  for (const sel of PROVIDERS[provider].send) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) { await btn.click(); return; }
    } catch {}
  }
  await input.press("Enter");
}
async function sendPrompt(page, provider, prompt, imageFiles = [], onDelta = null) {
  let submitted = false;
  try {
    const previous = await getLastResponse(page, provider);
    const input = await findVisible(page, PROVIDERS[provider].input);
    if (imageFiles.length) await attachImages(page, provider, imageFiles);
    await setInput(input, prompt);
    await sleep(180);
    await submitComposer(page, provider, input);
    submitted = true;
    return await waitForResponse(page, provider, previous, onDelta);
  } catch (e) {
    throw markError(e, { safeToRetry: !submitted, stage: submitted ? "response" : "prepare" });
  }
}

// ---------- runtime / recovery ----------
class Runtime {
  constructor(provider) {
    this.provider = provider;
    this.context = null;
    this.page = null;
    this.queue = Promise.resolve();
    this.using = "";
    this.selectedModelKey = "";
    this.selectedModelLabel = "";
    this.recoveries = 0;
    this.lastError = "";
    this.lastRecoveryAt = null;
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
  async recover(reason = "") {
    if (!AUTO_RECOVER) return;
    this.recoveries++;
    this.lastError = String(reason || "");
    this.lastRecoveryAt = new Date().toISOString();
    this.selectedModelKey = "";
    this.selectedModelLabel = "";
    console.warn(`[${this.provider}] recovering browser session${reason ? `: ${String(reason).split("\n")[0]}` : ""}`);

    const previousUrl = (() => {
      try { return this.page && !this.page.isClosed() ? this.page.url() : ""; } catch { return ""; }
    })();

    if (this.page && !this.page.isClosed()) {
      try {
        await this.page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
        return;
      } catch {}
      try { await this.page.close().catch(() => {}); } catch {}
      this.page = null;
    }

    try {
      if (!this.context) await this.start();
      this.page = await this.context.newPage();
      const target = previousUrl && /^https?:/i.test(previousUrl) ? previousUrl : PROVIDERS[this.provider].url;
      await this.page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
      return;
    } catch {}

    await this.close();
    await this.start();
    this.page = await this.context.newPage();
    await this.page.goto(PROVIDERS[this.provider].url, { waitUntil: "domcontentloaded", timeout: 60000 });
  }
  enqueue(fn) {
    const r = this.queue.then(fn, fn);
    this.queue = r.catch(() => {});
    return r;
  }
  status() {
    return {
      started: Boolean(this.context),
      page_open: Boolean(this.page && !this.page.isClosed()),
      selected_model: this.selectedModelLabel || null,
      recoveries: this.recoveries,
      last_error: this.lastError || null,
      last_recovery_at: this.lastRecoveryAt,
    };
  }
  async close() {
    try { await this.page?.close().catch(() => {}); } finally { this.page = null; }
    if (this.context) { await this.context.close().catch(() => {}); this.context = null; }
    this.selectedModelKey = "";
    this.selectedModelLabel = "";
  }
}
const runtimes = Object.fromEntries(PROVIDER_NAMES.map((p) => [p, new Runtime(p)]));

async function withRecovery(provider, task) {
  const runtime = runtimes[provider];
  let lastErr;
  for (let attempt = 0; attempt <= RECOVERY_RETRIES; attempt++) {
    try { return await task(attempt); }
    catch (e) {
      lastErr = e;
      runtime.lastError = String(e?.message || e);
      const mayRetry = AUTO_RECOVER && attempt < RECOVERY_RETRIES && shouldRetryError(e);
      if (AUTO_RECOVER) await runtime.recover(e?.message || e).catch((recoveryErr) => {
        console.warn(`[${provider}] recovery failed: ${recoveryErr.message}`);
      });
      if (!mayRetry) throw e;
      console.warn(`[${provider}] retrying request after recoverable pre-send failure (${attempt + 1}/${RECOVERY_RETRIES})`);
    }
  }
  throw lastErr;
}

// ---------- response shapes ----------
function makeUsage(promptTokens, completionTokens) {
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
}
const responseObject = (model, content, usage) => ({
  id: `chatcmpl-${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: usage || makeUsage(0, countTokens(content)),
});
const toolResponse = (model, call, usage) => ({
  id: `chatcmpl-${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
  choices: [{
    index: 0,
    message: {
      role: "assistant", content: null,
      tool_calls: [{
        id: `call_${Date.now()}`, type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }],
    },
    finish_reason: "tool_calls",
  }],
  usage: usage || makeUsage(0, countTokens(JSON.stringify(call.arguments))),
});

// ---------- completions ----------
async function completionContext(body) {
  const explicitProvider = String(body.provider || "").toLowerCase();
  const fallbackProvider = PROVIDERS[explicitProvider] ? explicitProvider : "chatgpt";
  const requestedModel = body.model || fallbackProvider;
  let resolvedModel = resolveModel(requestedModel);
  const provider = PROVIDERS[explicitProvider] ? explicitProvider : resolvedModel.provider;
  const runtime = runtimes[provider];
  const page = await runtime.pageFor();

  if (PROVIDERS[explicitProvider] && resolvedModel.known && resolvedModel.provider !== provider) {
    throw markError(new Error(`Requested model ${JSON.stringify(requestedModel)} belongs to ${resolvedModel.provider}, but provider=${provider}`), { safeToRetry: false, stage: "prepare" });
  }

  if (AUTO_DISCOVER_MODELS && !resolvedModel.known) {
    await discoverModelsOnPage(page, provider).catch(() => []);
    resolvedModel = resolveModel(requestedModel);
  }

  const modelForSelection = resolvedModel.provider === provider ? requestedModel : provider;
  await selectModel(page, runtime, modelForSelection);

  const messages = body.messages || [];
  const tools = body.tools || [];
  const toolChoice = toolChoiceOf(body);
  let imageFiles = [];
  try {
    imageFiles = await materializeImages(extractImages(messages));
  } catch (e) {
    throw markError(e, { safeToRetry: false, stage: "prepare" });
  }
  const prompt = [toolPrompt(tools, toolChoice), buildPrompt(messages)].filter(Boolean).join("\n\n");

  return { provider, runtime, page, model: requestedModel, messages, tools, toolChoice, imageFiles, prompt };
}

async function runCompletion(body) {
  const ctx = await completionContext(body);
  let promptTokens = countTokens(ctx.prompt), completionTokens = 0;
  try {
    let reply = await sendPrompt(ctx.page, ctx.provider, ctx.prompt, ctx.imageFiles);
    completionTokens += countTokens(reply);
    for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
      const call = parseTool(reply);
      if (!call) return responseObject(ctx.model, reply, makeUsage(promptTokens, completionTokens));
      if (!validTool(call, ctx.tools)) throw markError(new Error(`Unknown tool: ${call.name}`), { safeToRetry: false });
      if (!TOOL_ENDPOINT) return toolResponse(ctx.model, call, makeUsage(promptTokens, countTokens(JSON.stringify(call))));
      let result;
      try { result = await executeTool(call); } catch (e) { result = { error: e.message }; }
      const followup = `TOOL RESULT FOR ${call.name}:\n${JSON.stringify(result)}\n\nContinue the original request.\nIf another tool is required, use the exact KODEXA_TOOL format again.\nOtherwise answer normally.`;
      promptTokens += countTokens(followup);
      reply = await sendPrompt(ctx.page, ctx.provider, followup);
      completionTokens += countTokens(reply);
    }
    throw markError(new Error("Maximum tool loops exceeded"), { safeToRetry: false });
  } finally { cleanupFiles(ctx.imageFiles); }
}

function sseWrite(res, data) {
  if (res.writableEnded || res.destroyed) return false;
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
  return true;
}
function chunkObject(id, created, model, delta, finishReason = null) {
  return { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
}
async function runCompletionStream(body, res) {
  const ctx = await completionContext(body);
  const id = `chatcmpl-${Date.now()}`, created = Math.floor(Date.now() / 1000);
  let promptTokens = countTokens(ctx.prompt), completionTokens = 0, emittedRole = false, emittedContent = "";
  const toolsActive = ctx.tools.length > 0 && ctx.toolChoice !== "none";
  const emitRole = () => {
    if (emittedRole) return;
    emittedRole = true;
    sseWrite(res, chunkObject(id, created, ctx.model, { role: "assistant" }));
  };
  const emitText = (delta) => {
    if (!delta) return;
    emitRole(); emittedContent += delta;
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
          sseWrite(res, { id, object: "chat.completion.chunk", created, model: ctx.model, choices: [], usage: makeUsage(promptTokens, completionTokens) });
        }
        sseWrite(res, "[DONE]");
        return;
      }
      if (!validTool(call, ctx.tools)) throw markError(new Error(`Unknown tool: ${call.name}`), { safeToRetry: false });
      if (!TOOL_ENDPOINT) {
        emitRole();
        const callId = `call_${Date.now()}`;
        sseWrite(res, chunkObject(id, created, ctx.model, {
          tool_calls: [{ index: 0, id: callId, type: "function", function: { name: call.name, arguments: "" } }],
        }));
        sseWrite(res, chunkObject(id, created, ctx.model, {
          tool_calls: [{ index: 0, function: { arguments: JSON.stringify(call.arguments) } }],
        }));
        sseWrite(res, chunkObject(id, created, ctx.model, {}, "tool_calls"));
        if (body.stream_options?.include_usage) {
          sseWrite(res, { id, object: "chat.completion.chunk", created, model: ctx.model, choices: [], usage: makeUsage(promptTokens, completionTokens) });
        }
        sseWrite(res, "[DONE]");
        return;
      }

      let result;
      try { result = await executeTool(call); } catch (e) { result = { error: e.message }; }
      const followup = `TOOL RESULT FOR ${call.name}:\n${JSON.stringify(result)}\n\nContinue the original request.\nIf another tool is required, use the exact KODEXA_TOOL format again.\nOtherwise answer normally.`;
      promptTokens += countTokens(followup);
      reply = await sendPrompt(ctx.page, ctx.provider, followup);
      completionTokens += countTokens(reply);
    }
    throw markError(new Error("Maximum tool loops exceeded"), { safeToRetry: false });
  } finally { cleanupFiles(ctx.imageFiles); }
}

// ---------- discovery / provider info ----------
async function discoverProvider(provider, force = true) {
  if (!PROVIDERS[provider]) throw new Error(`Unknown provider: ${provider}`);
  const runtime = runtimes[provider];
  return runtime.enqueue(async () => {
    const page = await runtime.pageFor();
    const models = await discoverModelsOnPage(page, provider, { force });
    return {
      provider,
      models,
      count: models.length,
      discovered_at: DISCOVERY_CACHE.get(provider)?.at || Date.now(),
    };
  });
}
function providerInfo(provider) {
  const cached = DISCOVERY_CACHE.get(provider);
  return {
    id: provider,
    title: PROVIDERS[provider].title,
    capabilities: modelCapabilities(provider),
    discovery: {
      cached: Boolean(cached),
      count: cached?.models?.length || 0,
      age_ms: cached ? Math.max(0, Date.now() - cached.at) : null,
    },
    runtime: runtimes[provider].status(),
  };
}

// ---------- login/server ----------
async function login(provider) {
  provider = String(provider || "").toLowerCase();
  if (!PROVIDERS[provider]) throw new Error(`Use one of: ${PROVIDER_NAMES.join(", ")}`);
  if (CHROME_USER_DATA_DIR) console.log("Close ALL Chrome windows first (profile is locked while Chrome runs).");
  const dir = profileDirFor(provider);
  console.log(`[${provider}] opening ${browserLabel()} | profile: ${dir}`);
  console.log(`[${provider}] -> ${PROVIDERS[provider].url}`);
  const context = await stealthContext(dir, false);
  const page = context.pages()[0] || await context.newPage();
  await page.goto(PROVIDERS[provider].url, { waitUntil: "domcontentloaded" });
  console.log(`\nLog into ${PROVIDERS[provider].title} in the browser window.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question("\nPress ENTER when logged in... ", resolve));
  rl.close();
  await context.close();
  console.log(`${provider} profile saved -> ${dir}`);
}

function validateExposureConfig() {
  if (!isLoopbackHost(HOST) && !API_KEY && !ALLOW_UNAUTHENTICATED) {
    throw new Error(
      `Refusing to bind to ${HOST} without API_KEY. Set API_KEY in .env, or set ALLOW_UNAUTHENTICATED=1 only if you really intend to expose an unauthenticated gateway.`
    );
  }
}

async function startServer() {
  validateExposureConfig();
  ensureDir(PROFILE_ROOT); ensureDir(TMP_ROOT);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: BODY_LIMIT }));

  app.get("/health", (req, res) => res.json({
    ok: true,
    providers: PROVIDER_NAMES,
    browser: browserLabel(),
    host: HOST,
    auth_required: Boolean(API_KEY),
    toolExecution: Boolean(TOOL_ENDPOINT),
    tokenizer: _enc ? "cl100k_base" : "fallback",
    auto_recover: AUTO_RECOVER,
    recovery_retries: RECOVERY_RETRIES,
    streaming: true,
    images: true,
    modelSelection: true,
    modelDiscovery: true,
  }));

  app.use("/v1", authMiddleware);

  app.get("/v1/providers", (req, res) => {
    res.json({ object: "list", data: PROVIDER_NAMES.map(providerInfo) });
  });

  app.get("/v1/models", async (req, res) => {
    const provider = String(req.query.provider || "").toLowerCase();
    if (provider && !PROVIDERS[provider]) {
      return res.status(400).json({ error: { message: `Unknown provider: ${provider}` } });
    }
    const refresh = ["1", "true", "yes"].includes(String(req.query.refresh || "").toLowerCase());
    if (refresh) {
      const targets = provider ? [provider] : PROVIDER_NAMES;
      const discovery = [];
      for (const p of targets) {
        try { discovery.push(await discoverProvider(p, true)); }
        catch (e) { discovery.push({ provider: p, error: e.message, models: [], count: 0 }); }
      }
      return res.json({ object: "list", data: publicModels(provider), discovery });
    }
    res.json({ object: "list", data: publicModels(provider) });
  });

  app.post("/v1/providers/:provider/discover", async (req, res) => {
    const provider = String(req.params.provider || "").toLowerCase();
    if (!PROVIDERS[provider]) return res.status(404).json({ error: { message: `Unknown provider: ${provider}` } });
    try { res.json(await discoverProvider(provider, true)); }
    catch (e) { res.status(500).json({ error: { message: e.message, provider } }); }
  });

  app.post("/v1/chat/completions", async (req, res) => {
    const body = req.body || {};
    const provider = getProvider(body);
    if (!PROVIDERS[provider]) return res.status(400).json({ error: { message: `Unknown provider: ${provider}` } });

    if (body.stream) {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      try {
        await runtimes[provider].enqueue(() =>
          withRecovery(provider, () => runCompletionStream(body, res))
        );
      } catch (e) {
        console.error(e);
        sseWrite(res, { error: { message: e.message, provider, stage: e.stage || null } });
        sseWrite(res, "[DONE]");
      } finally { if (!res.writableEnded) res.end(); }
      return;
    }

    try {
      const result = await runtimes[provider].enqueue(() =>
        withRecovery(provider, () => runCompletion(body))
      );
      res.json(result);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: { message: e.message, provider, stage: e.stage || null } });
    }
  });

  const server = app.listen(PORT, HOST, () => {
    console.log(`API running: http://${HOST}:${PORT}/v1/chat/completions (${browserLabel()})`);
    console.log(`Providers: ${PROVIDER_NAMES.join(", ")}`);
    console.log(`API auth: ${API_KEY ? "required" : "disabled"}`);
  });

  const shutdown = async () => {
    console.log("\nShutting down...");
    server.close();
    await Promise.all(Object.values(runtimes).map((r) => r.close()));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const [command, provider] = process.argv.slice(2);
  if (command === "login") {
    if (provider) await login(provider);
    else for (const p of PROVIDER_NAMES) await login(p);
    return;
  }
  if (command === "discover") {
    const targets = provider ? [provider.toLowerCase()] : PROVIDER_NAMES;
    for (const p of targets) {
      const result = await discoverProvider(p, true);
      console.log(JSON.stringify(result, null, 2));
    }
    await Promise.all(Object.values(runtimes).map((r) => r.close()));
    return;
  }
  await startServer();
}
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  countTokens, normalizeContent, extractImages, buildPrompt, serializeMessages, serializeMessage,
  toolChoiceOf, toolPrompt, parseTool, validTool, makeUsage, responseObject, toolResponse,
  getProvider, deltaFrom, inferProviderFromModel, resolveModel, publicModels, selectModel,
  discoverModelsOnPage, providerInfo, authMiddleware, shouldRetryError,
  PROVIDERS, PROVIDER_NAMES,
};
