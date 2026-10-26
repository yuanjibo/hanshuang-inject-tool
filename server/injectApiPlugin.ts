/**
 * 本地注入后端（Vite 开发/预览服务器中间件）。
 *
 * 浏览器版没有 Tauri 后端，这个插件补上「真正读写本机文件」的能力：把提示词
 * 写进各个客户端自己的全局指令文件。Codex 另有两个只有它才有的位置——系统提示
 * 替换（model_instructions_file）和记忆 MEMORY.md。
 *
 * 所有写入都先备份到 ~/.cc-switch/backups/inject/<应用>/，可一键还原。
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

// HANSHUANG_HOME 覆盖数据根（见 .env.hanshuang），便于把数据固定到非系统盘。
const HOME = process.env.HANSHUANG_HOME || os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
const BACKUP_BASE = path.join(HOME, ".cc-switch", "backups", "inject");
const STATE_FILE = path.join(HOME, ".cc-switch", "inject-state.json");

interface TargetDef {
  /** 在所属应用内唯一 */
  id: string;
  name: string;
  description: string;
  file: string;
  /** 该目标是否需要同时改一个配置文件（只有 Codex 的系统提示替换要） */
  configFile?: string;
}

interface AppDef {
  id: string;
  name: string;
  targets: TargetDef[];
}

/** 各客户端每次会话自动加载的用户级指令文件。 */
function globalInstruction(
  id: string,
  name: string,
  file: string,
  fileName: string,
): AppDef {
  return {
    id,
    name,
    targets: [
      {
        id: "agents",
        name: `全局指令 ${fileName}`,
        description: `${name} 每次会话自动加载的用户级指令，对所有项目生效。最常用的注入位置。`,
        file,
      },
    ],
  };
}

const APPS: Record<string, AppDef> = {
  claude: globalInstruction(
    "claude",
    "Claude Code",
    path.join(HOME, ".claude", "CLAUDE.md"),
    "CLAUDE.md",
  ),
  codex: {
    id: "codex",
    name: "Codex",
    targets: [
      {
        id: "agents",
        name: "全局指令 AGENTS.md",
        description:
          "Codex 每次会话自动加载的用户级指令，对所有项目生效。最常用的注入位置。",
        file: path.join(CODEX_HOME, "AGENTS.md"),
      },
      {
        id: "system",
        name: "系统提示替换（model_instructions_file）",
        description:
          "写入独立的提示词文件，并在 config.toml 里把 model_instructions_file 指向它。会替换 Codex 官方基础指令，重启后生效。",
        file: path.join(CODEX_HOME, "system-prompt.md"),
        configFile: path.join(CODEX_HOME, "config.toml"),
      },
      {
        id: "memory",
        name: "记忆 MEMORY.md",
        description:
          "Codex 的长期记忆文件。写入后由记忆功能按它的规则读取（需开启 memories 功能）。",
        file: path.join(CODEX_HOME, "memories", "MEMORY.md"),
      },
    ],
  },
  gemini: globalInstruction(
    "gemini",
    "Gemini CLI",
    path.join(HOME, ".gemini", "GEMINI.md"),
    "GEMINI.md",
  ),
  grokbuild: globalInstruction(
    "grokbuild",
    "Grok Build",
    path.join(HOME, ".grok", "AGENTS.md"),
    "AGENTS.md",
  ),
  opencode: globalInstruction(
    "opencode",
    "OpenCode",
    path.join(HOME, ".config", "opencode", "AGENTS.md"),
    "AGENTS.md",
  ),
  openclaw: globalInstruction(
    "openclaw",
    "OpenClaw",
    path.join(HOME, ".openclaw", "AGENTS.md"),
    "AGENTS.md",
  ),
  hermes: globalInstruction(
    "hermes",
    "Hermes",
    path.join(HOME, ".hermes", "SOUL.md"),
    "SOUL.md",
  ),
  pi: globalInstruction(
    "pi",
    "Pi",
    path.join(HOME, ".pi", "agent", "AGENTS.md"),
    "AGENTS.md",
  ),
  mcode: globalInstruction(
    "mcode",
    "MiniMax Code",
    path.join(HOME, ".minimax", "AGENTS.md"),
    "AGENTS.md",
  ),
  dsh: globalInstruction(
    "dsh",
    "DeepSeek Harness",
    path.join(HOME, ".dsh", "AGENTS.md"),
    "AGENTS.md",
  ),
};

/** Claude Desktop 和 Claude Code 共用 ~/.claude/CLAUDE.md。 */
function resolveApp(value: string): AppDef | null {
  if (value === "claude-desktop") return APPS.claude;
  return APPS[value] ?? null;
}

interface BackupEntry {
  id: string;
  app: string;
  target: string;
  /** 存一份展示名，前端列备份时不用再去 overview 里查 */
  targetName: string;
  originalPath: string;
  originalExisted: boolean;
  createdAt: number;
  size: number;
  file: string;
}

interface TargetState {
  installedAt: number;
  backupId: string | null;
  originalExisted: boolean;
  /** 仅 Codex 的 system：注入前 config.toml 里 model_instructions_file 的值 */
  originalConfigValue?: string | null;
  configBackupId?: string | null;
}

type InjectState = Record<string, Record<string, TargetState>>;

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

function backupRoot(app: string): string {
  return path.join(BACKUP_BASE, app);
}

async function readBackups(app: string): Promise<BackupEntry[]> {
  return readJsonSafe<BackupEntry[]>(
    path.join(backupRoot(app), "index.json"),
    [],
  );
}

async function writeBackups(app: string, entries: BackupEntry[]) {
  await ensureDir(backupRoot(app));
  await fsp.writeFile(
    path.join(backupRoot(app), "index.json"),
    JSON.stringify(entries, null, 2),
    "utf8",
  );
}

async function readState(): Promise<InjectState> {
  return readJsonSafe<InjectState>(STATE_FILE, {});
}

async function writeState(state: InjectState) {
  await ensureDir(path.dirname(STATE_FILE));
  await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

/** 备份一个文件（不存在也记一条，用于还原时删除）。 */
async function backupFile(
  app: string,
  target: string,
  targetName: string,
  filePath: string,
): Promise<BackupEntry> {
  const stat = await statSafe(filePath);
  const id = `${Date.now()}-${target}-${Math.random().toString(36).slice(2, 8)}`;
  const file = `${id}.bak`;
  const root = backupRoot(app);
  await ensureDir(root);

  if (stat?.isFile()) {
    await fsp.copyFile(filePath, path.join(root, file));
  }

  const entry: BackupEntry = {
    id,
    app,
    target,
    targetName,
    originalPath: filePath,
    originalExisted: Boolean(stat?.isFile()),
    createdAt: Date.now(),
    size: stat?.isFile() ? stat.size : 0,
    file,
  };
  const backups = await readBackups(app);
  backups.unshift(entry);
  await writeBackups(app, backups.slice(0, 200));
  return entry;
}

async function restoreBackup(app: string, id: string): Promise<BackupEntry> {
  const backups = await readBackups(app);
  const entry = backups.find((item) => item.id === id);
  if (!entry) throw new Error("备份不存在");

  if (entry.originalExisted) {
    const source = path.join(backupRoot(app), entry.file);
    if (!(await statSafe(source))) throw new Error("备份文件已丢失");
    await ensureDir(path.dirname(entry.originalPath));
    await fsp.copyFile(source, entry.originalPath);
  } else {
    await fsp.rm(entry.originalPath, { force: true });
  }
  return entry;
}

/** 从 config.toml 里读 model_instructions_file 的值。 */
function extractModelInstructions(configText: string): string | null {
  const match = configText.match(
    /^\s*model_instructions_file\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/m,
  );
  if (!match) return null;
  const raw = match[1] ?? match[2] ?? "";
  return raw.replace(/\\\\/g, "\\");
}

/** 写/删 config.toml 的顶层 model_instructions_file，保留其余内容和注释。 */
function setModelInstructions(configText: string, value: string | null): string {
  const lines = configText.split(/\r?\n/);
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*model_instructions_file\s*=/.test(lines[i])) {
      index = i;
      break;
    }
  }

  if (value === null) {
    if (index >= 0) {
      // 注入时在键后面加了一个空行；还原时一并吃掉，避免留下空行
      const nextIsBlank =
        index + 1 < lines.length && lines[index + 1].trim() === "";
      const nextNextIsTable =
        index + 2 < lines.length && /^\s*\[/.test(lines[index + 2]);
      if (nextIsBlank && nextNextIsTable) lines.splice(index, 2);
      else lines.splice(index, 1);
    }
    return lines.join("\n");
  }

  // TOML 双引号字符串；正斜杠路径不需要转义
  const line = `model_instructions_file = "${value.replace(/\\/g, "/")}"`;
  if (index >= 0) {
    lines[index] = line;
  } else {
    let insertAt = lines.findIndex((item) => /^\s*\[/.test(item));
    if (insertAt < 0) insertAt = lines.length;
    lines.splice(insertAt, 0, line, "");
  }
  return lines.join("\n");
}

function samePath(a: string | null, b: string): boolean {
  if (!a) return false;
  const normalize = (value: string) =>
    path.resolve(value.replace(/\\/g, "/")).toLowerCase();
  try {
    return normalize(a) === normalize(b);
  } catch {
    return false;
  }
}

async function buildOverview(app: AppDef) {
  const state = await readState();
  const appState = state[app.id] ?? {};

  // 只有 Codex 有 config.toml 这一环
  const configTarget = app.targets.find((item) => item.configFile);
  const configText = configTarget
    ? ((await readTextSafe(configTarget.configFile!)) ?? "")
    : "";
  const configValue = configTarget
    ? extractModelInstructions(configText)
    : null;

  const targets = [];
  for (const def of app.targets) {
    const stat = await statSafe(def.file);
    const content = stat?.isFile() ? ((await readTextSafe(def.file)) ?? "") : "";
    const saved = appState[def.id];
    const active = def.configFile
      ? samePath(configValue, def.file) && Boolean(stat?.isFile())
      : Boolean(content.trim());

    targets.push({
      id: def.id,
      name: def.name,
      description: def.description,
      path: def.file,
      displayPath: displayPath(def.file),
      exists: Boolean(stat?.isFile()),
      size: stat?.isFile() ? stat.size : 0,
      mtime: stat?.mtimeMs ?? null,
      content,
      active,
      injected: Boolean(saved),
      installedAt: saved?.installedAt ?? null,
      configPath: def.configFile ? displayPath(def.configFile) : null,
    });
  }

  const homeDir = path.dirname(app.targets[0].file);

  return {
    app: app.id,
    appName: app.name,
    homeDir,
    homeDirDisplay: displayPath(homeDir),
    configValue,
    configValueDisplay: configValue ? displayPath(configValue) : null,
    targets,
    backups: (await readBackups(app.id)).slice(0, 30),
  };
}

async function applyInjection(
  app: AppDef,
  targetId: string,
  content: string,
  mode: "replace" | "append",
) {
  const def = app.targets.find((item) => item.id === targetId);
  if (!def) throw new Error("未知的注入目标");
  if (typeof content !== "string") throw new Error("缺少提示词内容");
  if (Buffer.byteLength(content, "utf8") > 4 * 1024 * 1024) {
    throw new Error("提示词超过 4 MB 限制");
  }

  const state = await readState();
  const appState = (state[app.id] ??= {});
  const first = !appState[targetId];

  const fileBackup = await backupFile(app.id, targetId, def.name, def.file);
  await ensureDir(path.dirname(def.file));

  if (def.configFile) {
    if (first) {
      const configText = (await readTextSafe(def.configFile)) ?? "";
      const configBackup = await backupFile(
        app.id,
        `${targetId}-config`,
        path.basename(def.configFile),
        def.configFile,
      );
      appState[targetId] = {
        installedAt: Date.now(),
        backupId: fileBackup.id,
        originalExisted: fileBackup.originalExisted,
        originalConfigValue: extractModelInstructions(configText),
        configBackupId: configBackup.id,
      };
    }
    await fsp.writeFile(def.file, content, "utf8");

    const configText = (await readTextSafe(def.configFile)) ?? "";
    await fsp.writeFile(
      def.configFile,
      setModelInstructions(configText, def.file),
      "utf8",
    );
  } else {
    if (mode === "append" && fileBackup.originalExisted) {
      const current = (await readTextSafe(def.file)) ?? "";
      const separator = current.endsWith("\n") ? "\n" : "\n\n";
      await fsp.writeFile(def.file, current + separator + content, "utf8");
    } else {
      await fsp.writeFile(def.file, content, "utf8");
    }
    if (first) {
      appState[targetId] = {
        installedAt: Date.now(),
        backupId: fileBackup.id,
        originalExisted: fileBackup.originalExisted,
      };
    }
  }

  await writeState(state);
  return buildOverview(app);
}

async function disableInjection(app: AppDef, targetId: string) {
  const def = app.targets.find((item) => item.id === targetId);
  if (!def) throw new Error("未知的注入目标");

  const state = await readState();
  const saved = state[app.id]?.[targetId];
  if (!saved) throw new Error("这个目标还没有通过本工具注入过，无法自动还原");

  if (saved.backupId) {
    await restoreBackup(app.id, saved.backupId);
  } else {
    await fsp.rm(def.file, { force: true });
  }

  if (def.configFile) {
    const configText = (await readTextSafe(def.configFile)) ?? "";
    await fsp.writeFile(
      def.configFile,
      setModelInstructions(configText, saved.originalConfigValue ?? null),
      "utf8",
    );
  }

  if (state[app.id]) delete state[app.id][targetId];
  await writeState(state);
  return buildOverview(app);
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
  if (!route.startsWith("/api/inject/")) return false;

  try {
    // /api/inject/<应用>/<动作>
    const [, , , appId, action] = route.split("/");

    // /api/inject/apps 列出支持的应用
    if (req.method === "GET" && appId === "apps" && !action) {
      sendJson(
        res,
        200,
        Object.values(APPS).map((item) => ({
          id: item.id,
          name: item.name,
          targetCount: item.targets.length,
        })),
      );
      return true;
    }

    const app = resolveApp(appId ?? "");
    if (!app) throw new Error(`不支持这个应用：${appId}`);

    if (req.method === "GET" && action === "overview") {
      sendJson(res, 200, await buildOverview(app));
      return true;
    }

    if (req.method === "POST" && action === "apply") {
      const body = await readBody(req);
      const targetId = typeof body.target === "string" ? body.target : "";
      const mode = body.mode === "append" ? "append" : "replace";
      const content = typeof body.content === "string" ? body.content : "";
      sendJson(res, 200, await applyInjection(app, targetId, content, mode));
      return true;
    }

    if (req.method === "POST" && action === "disable") {
      const body = await readBody(req);
      const targetId = typeof body.target === "string" ? body.target : "";
      sendJson(res, 200, await disableInjection(app, targetId));
      return true;
    }

    if (req.method === "POST" && action === "restore") {
      const body = await readBody(req);
      const backupId = typeof body.backupId === "string" ? body.backupId : "";
      if (!backupId) throw new Error("缺少备份 ID");
      const entry = await restoreBackup(app.id, backupId);
      sendJson(res, 200, {
        restored: entry,
        overview: await buildOverview(app),
      });
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

export function injectApiPlugin(): Plugin {
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
    name: "cc-switch-inject-api",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
