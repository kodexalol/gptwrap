// gptwrap multi-account gateway
// Runs the existing single-profile index.js engine as isolated localhost children.
// Each named account receives its own profile root and child process.
// Account selection is explicit/default-based; this does not rotate accounts to evade quotas or rate limits.

const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const core = require("./index");

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
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (e) {
    console.warn(`[env] could not read ${file}: ${e.message}`);
  }
}
loadEnvFile();

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const PROFILE_ROOT = path.resolve(process.env.PROFILE_ROOT || "./profiles");
const API_KEY = process.env.API_KEY || "";
const ALLOW_UNAUTHENTICATED = process.env.ALLOW_UNAUTHENTICATED === "1";
const ACCOUNTS_RAW = process.env.ACCOUNTS || "";
const DEFAULT_ACCOUNTS_RAW = process.env.DEFAULT_ACCOUNTS || "";
const ALLOW_DYNAMIC_ACCOUNTS = process.env.ALLOW_DYNAMIC_ACCOUNTS === "1";
const CHILD_PORT_BASE = Number(process.env.CHILD_PORT_BASE || 3100);
const CHILD_START_TIMEOUT = Number(process.env.CHILD_START_TIMEOUT || 30000);
const CHILD_IDLE_MS = Number(process.env.CHILD_IDLE_MS || 0);
const PROVIDERS = core.PROVIDER_NAMES || Object.keys(core.PROVIDERS || {});
const INTERNAL_KEY = crypto.randomBytes(32).toString("hex");

function parseObject(raw, name) {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("must be a JSON object");
    return value;
  } catch (e) {
    console.warn(`[multi] ${name} ignored: ${e.message}`);
    return {};
  }
}
function validAccount(id) { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(id || "")); }
function assertAccount(id) {
  const value = String(id || "default");
  if (!validAccount(value)) throw new Error(`Invalid account id ${JSON.stringify(value)}. Use 1-64 letters, numbers, dot, underscore or hyphen.`);
  return value;
}
const ACCOUNT_CONFIG = (() => {
  const parsed = parseObject(ACCOUNTS_RAW, "ACCOUNTS");
  const out = Object.fromEntries(PROVIDERS.map((p) => [p, ["default"]]));
  for (const provider of PROVIDERS) {
    const value = parsed[provider];
    if (value == null) continue;
    let ids = [];
    if (Array.isArray(value)) ids = value;
    else if (typeof value === "string") ids = [value];
    else if (value && typeof value === "object") ids = Object.keys(value);
    ids = [...new Set(ids.map(String).filter(validAccount))];
    if (!ids.includes("default")) ids.unshift("default");
    out[provider] = ids.length ? ids : ["default"];
  }
  return out;
})();
const DEFAULTS = parseObject(DEFAULT_ACCOUNTS_RAW, "DEFAULT_ACCOUNTS");
function configuredAccounts(provider) { return ACCOUNT_CONFIG[provider] || ["default"]; }
function defaultAccount(provider) {
  const wanted = String(DEFAULTS[provider] || "default");
  return configuredAccounts(provider).includes(wanted) ? wanted : "default";
}
function resolveAccount(provider, requested) {
  const account = assertAccount(requested || defaultAccount(provider));
  if (configuredAccounts(provider).includes(account) || ALLOW_DYNAMIC_ACCOUNTS) return account;
  throw new Error(`Unknown account ${JSON.stringify(account)} for ${provider}. Add it to ACCOUNTS or enable ALLOW_DYNAMIC_ACCOUNTS.`);
}
function accountRoot(account) {
  account = assertAccount(account);
  return account === "default" ? PROFILE_ROOT : path.join(PROFILE_ROOT, "accounts", account);
}
function accountProfile(provider, account) { return path.join(accountRoot(account), provider); }
function allConfiguredAccounts() {
  return [...new Set(PROVIDERS.flatMap((p) => configuredAccounts(p)))];
}
function providersForAccount(account) { return PROVIDERS.filter((p) => configuredAccounts(p).includes(account)); }
function isLoopback(host) { return ["127.0.0.1", "localhost", "::1"].includes(String(host).toLowerCase()); }
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function requestKey(req) {
  const auth = String(req.headers.authorization || "");
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return String(req.headers["x-api-key"] || "").trim();
}
function auth(req, res, next) {
  if (!API_KEY || safeEqual(requestKey(req), API_KEY)) return next();
  res.status(401).json({ error: { message: "Invalid or missing API key", type: "authentication_error" } });
}
function validateExposure() {
  if (!isLoopback(HOST) && !API_KEY && !ALLOW_UNAUTHENTICATED) {
    throw new Error(`Refusing to bind to ${HOST} without API_KEY. Set API_KEY or explicitly set ALLOW_UNAUTHENTICATED=1.`);
  }
  if (process.env.CHROME_USER_DATA_DIR && allConfiguredAccounts().some((a) => a !== "default")) {
    throw new Error("Multi-account mode cannot share CHROME_USER_DATA_DIR. Unset CHROME_USER_DATA_DIR and use gptwrap-managed profiles.");
  }
}

// ---------- child process manager ----------
const children = new Map();
let nextPort = CHILD_PORT_BASE;
function childEnv(account, port) {
  return {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    PROFILE_ROOT: accountRoot(account),
    TMP_ROOT: path.join(accountRoot(account), ".tmp"),
    API_KEY: INTERNAL_KEY,
    ALLOW_UNAUTHENTICATED: "0",
    ACCOUNTS: "",
    DEFAULT_ACCOUNTS: "",
    ALLOW_DYNAMIC_ACCOUNTS: "0",
  };
}
function prefixLines(stream, prefix, sink) {
  let buf = "";
  stream?.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || "";
    for (const line of lines) if (line) sink(`${prefix}${line}\n`);
  });
  stream?.on("end", () => { if (buf) sink(`${prefix}${buf}\n`); });
}
async function waitForChild(child) {
  const start = Date.now();
  while (Date.now() - start < CHILD_START_TIMEOUT) {
    if (child.proc.exitCode != null) throw new Error(`Account child ${child.account} exited with code ${child.proc.exitCode}`);
    try {
      const r = await fetch(`http://127.0.0.1:${child.port}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out starting account child ${child.account}`);
}
function touch(child) {
  child.lastUsed = Date.now();
  if (!CHILD_IDLE_MS) return;
  clearTimeout(child.idleTimer);
  child.idleTimer = setTimeout(() => stopChild(child.account).catch(() => {}), CHILD_IDLE_MS);
  child.idleTimer.unref?.();
}
async function startChild(account) {
  account = assertAccount(account);
  const existing = children.get(account);
  if (existing && existing.proc.exitCode == null) { touch(existing); return existing; }
  const port = nextPort++;
  fs.mkdirSync(accountRoot(account), { recursive: true });
  const proc = spawn(process.execPath, [path.resolve(__dirname, "index.js")], {
    cwd: process.cwd(),
    env: childEnv(account, port),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const child = { account, port, proc, startedAt: Date.now(), lastUsed: Date.now(), idleTimer: null };
  children.set(account, child);
  prefixLines(proc.stdout, `[child:${account}] `, (s) => process.stdout.write(s));
  prefixLines(proc.stderr, `[child:${account}] `, (s) => process.stderr.write(s));
  proc.once("exit", () => {
    clearTimeout(child.idleTimer);
    if (children.get(account) === child) children.delete(account);
  });
  try { await waitForChild(child); }
  catch (e) { proc.kill("SIGTERM"); throw e; }
  touch(child);
  return child;
}
async function stopChild(account) {
  const child = children.get(account);
  if (!child) return;
  children.delete(account);
  clearTimeout(child.idleTimer);
  if (child.proc.exitCode != null) return;
  child.proc.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.proc.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 4000)),
  ]);
  if (child.proc.exitCode == null) child.proc.kill("SIGKILL");
}
function childStatus(account) {
  const child = children.get(account);
  return child ? {
    running: child.proc.exitCode == null,
    port: child.port,
    pid: child.proc.pid,
    started_at: new Date(child.startedAt).toISOString(),
    last_used_at: new Date(child.lastUsed).toISOString(),
  } : { running: false, port: null, pid: null, started_at: null, last_used_at: null };
}

// ---------- proxy helpers ----------
function inferProvider(body) {
  const explicit = String(body.provider || "").toLowerCase();
  if (PROVIDERS.includes(explicit)) return explicit;
  return core.getProvider(body);
}
function routeFor(body, headerAccount = "") {
  const provider = inferProvider(body);
  if (!PROVIDERS.includes(provider)) throw new Error(`Unknown provider: ${provider}`);
  const account = resolveAccount(provider, body.account || headerAccount);
  return { provider, account };
}
function childHeaders(extra = {}) {
  return { Authorization: `Bearer ${INTERNAL_KEY}`, ...extra };
}
async function childFetch(account, urlPath, init = {}) {
  const child = await startChild(account);
  touch(child);
  return fetch(`http://127.0.0.1:${child.port}${urlPath}`, {
    ...init,
    headers: childHeaders(init.headers || {}),
  });
}
async function relayJson(res, upstream, account) {
  const text = await upstream.text();
  res.status(upstream.status);
  res.setHeader("X-GPTWrap-Account", account);
  const ct = upstream.headers.get("content-type");
  if (ct) res.setHeader("Content-Type", ct);
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object" && !Array.isArray(data)) data.account = data.account || account;
    res.send(JSON.stringify(data));
  } catch { res.send(text); }
}
async function relayStream(res, upstream, account) {
  res.status(upstream.status);
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-GPTWrap-Account", account);
  res.flushHeaders?.();
  if (!upstream.body) return res.end();
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise((resolve) => res.once("drain", resolve));
    }
  } finally { reader.releaseLock(); res.end(); }
}

// ---------- aggregated metadata ----------
function accountRecord(provider, account) {
  return {
    id: account,
    provider,
    default: account === defaultAccount(provider),
    profile_dir: accountProfile(provider, account),
    child: childStatus(account),
  };
}
async function providerRecord(provider) {
  const accounts = configuredAccounts(provider).map((a) => accountRecord(provider, a));
  return {
    id: provider,
    title: core.PROVIDERS?.[provider]?.title || provider,
    capabilities: { ...(core.PROVIDERS?.[provider]?.capabilities || {}), multi_account: true },
    default_account: defaultAccount(provider),
    accounts,
  };
}
async function modelsFor(provider, account, refresh) {
  const qs = new URLSearchParams();
  if (provider) qs.set("provider", provider);
  if (refresh) qs.set("refresh", "1");
  const upstream = await childFetch(account, `/v1/models?${qs.toString()}`);
  const data = await upstream.json();
  if (!upstream.ok) throw new Error(data?.error?.message || `Child models request failed (${upstream.status})`);
  for (const model of data.data || []) {
    model.account = account;
    model.accounts = [account];
    model.capabilities = { ...(model.capabilities || {}), multi_account: true };
  }
  return data;
}

// ---------- CLI ----------
function cliEnv(account) {
  return {
    ...process.env,
    PROFILE_ROOT: accountRoot(account),
    TMP_ROOT: path.join(accountRoot(account), ".tmp"),
    ACCOUNTS: "",
    DEFAULT_ACCOUNTS: "",
    ALLOW_DYNAMIC_ACCOUNTS: "0",
  };
}
function runCoreCli(args, account) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(accountRoot(account), { recursive: true });
    const proc = spawn(process.execPath, [path.resolve(__dirname, "index.js"), ...args], {
      cwd: process.cwd(), env: cliEnv(account), stdio: "inherit",
    });
    proc.once("error", reject);
    proc.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Child CLI exited ${code ?? signal}`)));
  });
}
async function loginCli(provider, accountArg) {
  provider = String(provider || "").toLowerCase();
  if (!PROVIDERS.includes(provider)) throw new Error(`Use one of: ${PROVIDERS.join(", ")}`);
  const account = resolveAccount(provider, accountArg);
  if (process.env.CHROME_USER_DATA_DIR && account !== "default") throw new Error("Named accounts require managed profiles; unset CHROME_USER_DATA_DIR.");
  console.log(`[multi] login ${provider}/${account} -> ${accountProfile(provider, account)}`);
  await runCoreCli(["login", provider], account);
}
async function discoverCli(provider, accountArg) {
  provider = String(provider || "").toLowerCase();
  if (!PROVIDERS.includes(provider)) throw new Error(`Use one of: ${PROVIDERS.join(", ")}`);
  const account = resolveAccount(provider, accountArg);
  console.log(`[multi] discover ${provider}/${account}`);
  await runCoreCli(["discover", provider], account);
}
function accountsCli(providerArg) {
  const targets = providerArg ? [String(providerArg).toLowerCase()] : PROVIDERS;
  for (const provider of targets) {
    if (!PROVIDERS.includes(provider)) throw new Error(`Unknown provider: ${provider}`);
    console.log(`${provider}:`);
    for (const account of configuredAccounts(provider)) {
      console.log(`  ${account}${account === defaultAccount(provider) ? " (default)" : ""} -> ${accountProfile(provider, account)}`);
    }
  }
}

// ---------- public gateway ----------
async function startGateway() {
  validateExposure();
  fs.mkdirSync(PROFILE_ROOT, { recursive: true });
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: process.env.BODY_LIMIT || "50mb" }));

  app.get("/health", (req, res) => res.json({
    ok: true,
    mode: "multi-account",
    providers: PROVIDERS,
    accounts: Object.fromEntries(PROVIDERS.map((p) => [p, configuredAccounts(p)])),
    children_running: [...children.keys()],
    auth_required: Boolean(API_KEY),
  }));

  app.use("/v1", auth);

  app.get("/v1/accounts", (req, res) => {
    const provider = String(req.query.provider || "").toLowerCase();
    if (provider && !PROVIDERS.includes(provider)) return res.status(400).json({ error: { message: `Unknown provider: ${provider}` } });
    const targets = provider ? [provider] : PROVIDERS;
    res.json({ object: "list", data: targets.flatMap((p) => configuredAccounts(p).map((a) => accountRecord(p, a))) });
  });

  app.get("/v1/providers", async (req, res) => {
    res.json({ object: "list", data: await Promise.all(PROVIDERS.map(providerRecord)) });
  });

  app.get("/v1/models", async (req, res) => {
    const provider = String(req.query.provider || "").toLowerCase();
    if (provider && !PROVIDERS.includes(provider)) return res.status(400).json({ error: { message: `Unknown provider: ${provider}` } });
    const requestedAccount = String(req.query.account || "");
    if (requestedAccount && !provider) return res.status(400).json({ error: { message: "account filter requires provider" } });
    const refresh = ["1", "true", "yes"].includes(String(req.query.refresh || "").toLowerCase());
    try {
      if (provider) {
        const account = resolveAccount(provider, requestedAccount);
        const data = await modelsFor(provider, account, refresh);
        return res.json(data);
      }
      const chunks = [];
      for (const p of PROVIDERS) {
        try { chunks.push(await modelsFor(p, defaultAccount(p), refresh)); }
        catch (e) { chunks.push({ data: [], discovery: [{ provider: p, error: e.message }] }); }
      }
      const seen = new Set();
      const models = [];
      for (const chunk of chunks) {
        for (const model of chunk.data || []) {
          const key = `${model.provider || ""}:${model.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          models.push(model);
        }
      }
      res.json({ object: "list", data: models, discovery: chunks.flatMap((x) => x.discovery || []) });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  app.post("/v1/providers/:provider/discover", async (req, res) => {
    const provider = String(req.params.provider || "").toLowerCase();
    if (!PROVIDERS.includes(provider)) return res.status(404).json({ error: { message: `Unknown provider: ${provider}` } });
    try {
      const account = resolveAccount(provider, req.body?.account || req.headers["x-gptwrap-account"]);
      const upstream = await childFetch(account, `/v1/providers/${provider}/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      await relayJson(res, upstream, account);
    } catch (e) { res.status(500).json({ error: { message: e.message, provider } }); }
  });

  app.post("/v1/chat/completions", async (req, res) => {
    const body = { ...(req.body || {}) };
    let route;
    try { route = routeFor(body, req.headers["x-gptwrap-account"]); }
    catch (e) { return res.status(400).json({ error: { message: e.message } }); }
    delete body.account;
    body.provider = route.provider;
    try {
      const upstream = await childFetch(route.account, "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (body.stream) return relayStream(res, upstream, route.account);
      return relayJson(res, upstream, route.account);
    } catch (e) {
      res.status(502).json({ error: { message: e.message, provider: route.provider, account: route.account } });
    }
  });

  const server = app.listen(PORT, HOST, () => {
    console.log(`gptwrap multi-account gateway: http://${HOST}:${PORT}`);
    console.log(`Providers: ${PROVIDERS.join(", ")}`);
    console.log(`Accounts: ${PROVIDERS.map((p) => `${p}=[${configuredAccounts(p).join(",")}]`).join(" ")}`);
    console.log(`Child ports start at 127.0.0.1:${CHILD_PORT_BASE}; children launch lazily.`);
    console.log(`API auth: ${API_KEY ? "required" : "disabled"}`);
  });

  const shutdown = async () => {
    console.log("\nShutting down multi-account gateway...");
    server.close();
    await Promise.all([...children.keys()].map(stopChild));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const [command, provider, account] = process.argv.slice(2);
  if (command === "login") {
    if (provider) return loginCli(provider, account);
    for (const p of PROVIDERS) for (const a of configuredAccounts(p)) await loginCli(p, a);
    return;
  }
  if (command === "discover") {
    if (provider) return discoverCli(provider, account);
    for (const p of PROVIDERS) await discoverCli(p, defaultAccount(p));
    return;
  }
  if (command === "accounts") return accountsCli(provider);
  await startGateway();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = {
  configuredAccounts,
  defaultAccount,
  resolveAccount,
  accountRoot,
  accountProfile,
  routeFor,
  startChild,
  stopChild,
  childStatus,
};
