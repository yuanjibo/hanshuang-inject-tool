/**
 * 提示词库后端（Vite 中间件）。
 *
 * 应用页的「提示词」列表：每个应用一组提示词，可以添加、编辑、删除、切换。
 * 切换 = 把该提示词写入对应工具的全局提示词文件（先备份，可还原）。
 *
 * 数据：
 *   ~/.cc-switch/prompt-library.json          提示词库
 *   ~/.cc-switch/prompt-library-state.json    每个应用第一次切换前的原始状态
 *   ~/.cc-switch/backups/prompt-library/      备份
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

// HANSHUANG_HOME 覆盖数据根（见 .env.hanshuang），便于把数据固定到非系统盘。
const HOME = process.env.HANSHUANG_HOME || os.homedir();
const LIBRARY_FILE = path.join(HOME, ".cc-switch", "prompt-library.json");
const STATE_FILE = path.join(HOME, ".cc-switch", "prompt-library-state.json");
const BACKUP_ROOT = path.join(HOME, ".cc-switch", "backups", "prompt-library");
const BACKUP_INDEX = path.join(BACKUP_ROOT, "index.json");

interface AppTarget {
  name: string;
  file: string;
}

const APP_TARGETS: Record<string, AppTarget> = {
  claude: { name: "Claude Code", file: path.join(HOME, ".claude", "CLAUDE.md") },
  "claude-desktop": {
    name: "Claude Desktop",
    file: path.join(HOME, ".claude", "CLAUDE.md"),
  },
  codex: { name: "Codex", file: path.join(HOME, ".codex", "AGENTS.md") },
  gemini: { name: "Gemini CLI", file: path.join(HOME, ".gemini", "GEMINI.md") },
  grokbuild: {
    name: "Grok Build",
    file: path.join(HOME, ".grok", "AGENTS.md"),
  },
  opencode: {
    name: "OpenCode",
    file: path.join(HOME, ".config", "opencode", "AGENTS.md"),
  },
  openclaw: {
    name: "OpenClaw",
    file: path.join(HOME, ".openclaw", "AGENTS.md"),
  },
  hermes: { name: "Hermes", file: path.join(HOME, ".hermes", "SOUL.md") },
  pi: { name: "Pi", file: path.join(HOME, ".pi", "agent", "AGENTS.md") },
  mcode: { name: "MiniMax Code", file: path.join(HOME, ".minimax", "AGENTS.md") },
  dsh: {
    name: "DeepSeek Harness",
    file: path.join(HOME, ".dsh", "AGENTS.md"),
  },
};

interface PromptItem {
  id: string;
  name: string;
  description: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

interface AppLibrary {
  currentId: string | null;
  prompts: PromptItem[];
}

interface Library {
  version: 1;
  apps: Record<string, AppLibrary>;
}

interface BackupEntry {
  id: string;
  app: string;
  originalPath: string;
  originalExisted: boolean;
  createdAt: number;
  size: number;
  file: string;
}

interface AppState {
  activatedAt: number;
  backupId: string | null;
  originalExisted: boolean;
}

interface LibraryState {
  apps: Record<string, AppState>;
}

function displayPath(filePath: string): string {
  const relative = path.relative(HOME, filePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join("/")}`;
  }
  return filePath.replace(/\\/g, "/");
}

async function ensureDir(dir: string) {
  await fsp.mkdir(dir, { recursive: true });
}

async function statSafe(filePath: string) {
  try {
    return await fsp.stat(filePath);
  } catch {
    return null;
  }
}

async function readTextSafe(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  const text = await readTextSafe(filePath);
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

async function readLibrary(): Promise<Library> {
  const library = await readJsonSafe<Library>(LIBRARY_FILE, {
    version: 1,
    apps: {},
  });
  if (!library.apps) library.apps = {};
  return library;
}

async function writeLibrary(library: Library) {
  await ensureDir(path.dirname(LIBRARY_FILE));
  await fsp.writeFile(LIBRARY_FILE, JSON.stringify(library, null, 2), "utf8");
}

async function readState(): Promise<LibraryState> {
  const state = await readJsonSafe<LibraryState>(STATE_FILE, { apps: {} });
  if (!state.apps) state.apps = {};
  return state;
}

async function writeState(state: LibraryState) {
  await ensureDir(path.dirname(STATE_FILE));
  await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

async function readBackups(): Promise<BackupEntry[]> {
  return readJsonSafe<BackupEntry[]>(BACKUP_INDEX, []);
}

async function backupFile(app: string, filePath: string): Promise<BackupEntry> {
  const stat = await statSafe(filePath);
  const id = `${Date.now()}-${app}-${Math.random().toString(36).slice(2, 8)}`;
  await ensureDir(BACKUP_ROOT);
  const file = `${id}.bak`;
  if (stat?.isFile()) {
    await fsp.copyFile(filePath, path.join(BACKUP_ROOT, file));
  }
  const entry: BackupEntry = {
    id,
    app,
    originalPath: filePath,
    originalExisted: Boolean(stat?.isFile()),
    createdAt: Date.now(),
    size: stat?.isFile() ? stat.size : 0,
    file,
  };
  const backups = await readBackups();
  backups.unshift(entry);
  await fsp.writeFile(
    BACKUP_INDEX,
    JSON.stringify(backups.slice(0, 300), null, 2),
    "utf8",
  );
  return entry;
}

async function restoreBackup(id: string): Promise<BackupEntry> {
  const backups = await readBackups();
  const entry = backups.find((item) => item.id === id);
  if (!entry) throw new Error("备份不存在");
  if (entry.originalExisted) {
    const source = path.join(BACKUP_ROOT, entry.file);
    if (!(await statSafe(source))) throw new Error("备份文件已丢失");
    await ensureDir(path.dirname(entry.originalPath));
    await fsp.copyFile(source, entry.originalPath);
  } else {
    await fsp.rm(entry.originalPath, { force: true });
  }
  return entry;
}

function targetOf(app: string): AppTarget {
  const target = APP_TARGETS[app];
  if (!target) throw new Error(`不支持的应用：${app}`);
  return target;
}

function bigrams(text: string): Set<string> {
  const clean = text.toLowerCase().replace(/\s+/g, "");
  const result = new Set<string>();
  for (let i = 0; i < clean.length - 1; i += 1) {
    result.add(clean.slice(i, i + 2));
  }
  return result;
}

function similarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const item of left) {
    if (right.has(item)) shared += 1;
  }
  return (2 * shared) / (left.size + right.size);
}

async function buildOverview(app: string) {
  const target = targetOf(app);
  const library = await readLibrary();
  const state = await readState();
  const stat = await statSafe(target.file);
  const fileContent = stat?.isFile() ? ((await readTextSafe(target.file)) ?? "") : "";
  const lib = library.apps[app] ?? { currentId: null, prompts: [] };
  const current = lib.prompts.find((item) => item.id === lib.currentId);

  return {
    app,
    appName: target.name,
    path: target.file,
    displayPath: displayPath(target.file),
    exists: Boolean(stat?.isFile()),
    size: stat?.isFile() ? stat.size : 0,
    mtime: stat?.mtimeMs ?? null,
    fileContent,
    currentId: lib.currentId,
    currentName: current?.name ?? null,
    prompts: lib.prompts,
    state: state.apps[app] ?? null,
  };
}

function normalizeApp(value: unknown): string {
  if (typeof value !== "string") throw new Error("缺少应用参数");
  return value;
}

function normalizeId(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("缺少提示词 ID");
  return value;
}

async function savePrompt(body: Record<string, unknown>) {
  const app = normalizeApp(body.app);
  targetOf(app);
  const library = await readLibrary();
  const lib = (library.apps[app] ??= { currentId: null, prompts: [] });
  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : "未命名提示词";
  const content = typeof body.content === "string" ? body.content : "";
  const description =
    typeof body.description === "string" ? body.description : "";
  if (!content.trim()) throw new Error("提示词内容是空的");
  if (Buffer.byteLength(content, "utf8") > 4 * 1024 * 1024) {
    throw new Error("提示词超过 4 MB 限制");
  }
  if (app === "mcode" && Buffer.byteLength(content, "utf8") > 32 * 1024) {
    throw new Error("MiniMax Code 的提示词不能超过 32 KB");
  }

  const id = typeof body.id === "string" && body.id ? body.id : `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const existing = lib.prompts.find((item) => item.id === id);
  const now = Date.now();
  if (existing) {
    existing.name = name;
    existing.description = description;
    existing.content = content;
    existing.updatedAt = now;
  } else {
    lib.prompts.push({
      id,
      name,
      description,
      content,
      createdAt: now,
      updatedAt: now,
    });
  }
  await writeLibrary(library);
  return { id, overview: await buildOverview(app) };
}

async function deletePrompt(body: Record<string, unknown>) {
  const app = normalizeApp(body.app);
  targetOf(app);
  const id = normalizeId(body.id);
  const library = await readLibrary();
  const lib = library.apps[app];
  if (!lib) throw new Error("这个应用还没有提示词");
  lib.prompts = lib.prompts.filter((item) => item.id !== id);
  if (lib.currentId === id) lib.currentId = null;
  await writeLibrary(library);
  return buildOverview(app);
}

async function activatePrompt(body: Record<string, unknown>) {
  const app = normalizeApp(body.app);
  const target = targetOf(app);
  const id = normalizeId(body.id);
  const library = await readLibrary();
  const lib = library.apps[app];
  const prompt = lib?.prompts.find((item) => item.id === id);
  if (!lib || !prompt) throw new Error("提示词不存在");

  const backup = await backupFile(app, target.file);
  const state = await readState();
  if (!state.apps[app]) {
    state.apps[app] = {
      activatedAt: Date.now(),
      backupId: backup.id,
      originalExisted: backup.originalExisted,
    };
    await writeState(state);
  }

  await ensureDir(path.dirname(target.file));
  await fsp.writeFile(target.file, prompt.content, "utf8");
  lib.currentId = id;
  await writeLibrary(library);
  return buildOverview(app);
}

async function deactivatePrompt(body: Record<string, unknown>) {
  const app = normalizeApp(body.app);
  const target = targetOf(app);
  const state = await readState();
  const saved = state.apps[app];
  if (!saved) throw new Error("这个应用还没有通过提示词库切换过");

  if (saved.backupId) {
    await restoreBackup(saved.backupId);
  } else {
    await fsp.rm(target.file, { force: true });
  }
  delete state.apps[app];
  await writeState(state);

  const library = await readLibrary();
  if (library.apps[app]) library.apps[app].currentId = null;
  await writeLibrary(library);
  return buildOverview(app);
}

async function importCurrent(body: Record<string, unknown>) {
  const app = normalizeApp(body.app);
  const target = targetOf(app);
  const content = (await readTextSafe(target.file)) ?? "";
  if (!content.trim()) throw new Error("当前提示词文件是空的");
  const library = await readLibrary();
  const lib = (library.apps[app] ??= { currentId: null, prompts: [] });
  const now = Date.now();
  const baseName = `当前文件 ${new Date(now).toLocaleString("zh-CN", { hour12: false })}`;
  let name = baseName;
  let index = 2;
  while (lib.prompts.some((item) => item.name === name)) {
    name = `${baseName} (${index})`;
    index += 1;
  }
  lib.prompts.push({
    id: `p_${now}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    description: `从 ${displayPath(target.file)} 导入`,
    content,
    createdAt: now,
    updatedAt: now,
  });
  await writeLibrary(library);
  return buildOverview(app);
}

async function listBackups(app: string) {
  const backups = await readBackups();
  return backups.filter((item) => item.app === app).slice(0, 50);
}

async function restoreLibraryBackup(body: Record<string, unknown>) {
  const id = normalizeId(body.backupId);
  const entry = await restoreBackup(id);
  return { restored: entry, overview: await buildOverview(entry.app) };
}

/** 给界面做「这段内容和已有的像不像」的判断，导入时避免重复。 */
async function findSimilar(body: Record<string, unknown>) {
  const app = normalizeApp(body.app);
  const content = typeof body.content === "string" ? body.content : "";
  const library = await readLibrary();
  const prompts = library.apps[app]?.prompts ?? [];
  return prompts
    .map((item) => ({ id: item.id, name: item.name, score: similarity(content, item.content) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 5 * 1024 * 1024) throw new Error("请求体超过 5 MB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const route = url.pathname;
  if (!route.startsWith("/api/prompt-library/")) return false;

  try {
    if (req.method === "GET" && route === "/api/prompt-library/overview") {
      sendJson(res, 200, await buildOverview(normalizeApp(url.searchParams.get("app"))));
      return true;
    }
    if (req.method === "GET" && route === "/api/prompt-library/backups") {
      sendJson(res, 200, await listBackups(normalizeApp(url.searchParams.get("app"))));
      return true;
    }
    if (req.method === "POST" && route === "/api/prompt-library/save") {
      sendJson(res, 200, await savePrompt(await readBody(req)));
      return true;
    }
    if (req.method === "POST" && route === "/api/prompt-library/delete") {
      sendJson(res, 200, await deletePrompt(await readBody(req)));
      return true;
    }
    if (req.method === "POST" && route === "/api/prompt-library/activate") {
      sendJson(res, 200, await activatePrompt(await readBody(req)));
      return true;
    }
    if (req.method === "POST" && route === "/api/prompt-library/deactivate") {
      sendJson(res, 200, await deactivatePrompt(await readBody(req)));
      return true;
    }
    if (req.method === "POST" && route === "/api/prompt-library/import-current") {
      sendJson(res, 200, await importCurrent(await readBody(req)));
      return true;
    }
    if (req.method === "POST" && route === "/api/prompt-library/restore") {
      sendJson(res, 200, await restoreLibraryBackup(await readBody(req)));
      return true;
    }
    if (req.method === "POST" && route === "/api/prompt-library/similar") {
      sendJson(res, 200, await findSimilar(await readBody(req)));
      return true;
    }
    sendJson(res, 404, { error: "未找到接口" });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { error: message });
    return true;
  }
}

export function promptLibraryPlugin(): Plugin {
  const middleware = (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleApi(req, res, url).then((handled) => {
      if (!handled) next();
    });
  };

  return {
    name: "cc-switch-prompt-library",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
