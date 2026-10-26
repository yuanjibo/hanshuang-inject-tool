/**
 * Codex 全局提示词资产后端。
 *
 * 把 Codex 所有会读到 / 用来注入提示词的位置集中列出来：
 *   AGENTS.md、system-prompt.md、config.toml（提示词相关键）、
 *   memories/、instructions/、rules/、hooks.json + hooks/、prompts/、skills/。
 *
 * 只允许读写信中白名单内的路径；每次写入前备份到
 *   ~/.cc-switch/backups/codex-assets/。
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

// HANSHUANG_HOME 覆盖数据根（见 .env.hanshuang），便于把数据固定到非系统盘。
const HOME = process.env.HANSHUANG_HOME || os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
const BACKUP_ROOT = path.join(HOME, ".cc-switch", "backups", "codex-assets");
const BACKUP_INDEX = path.join(BACKUP_ROOT, "index.json");
const MAX_FILE_SIZE = 4 * 1024 * 1024;

const ALLOWED_KEYS = [
  "AGENTS.md",
  "system-prompt.md",
  "config.toml",
  "memories",
  "instructions",
  "rules",
  "hooks.json",
  "hooks",
  "prompts",
  "skills",
];

const EDITABLE_EXTENSIONS = new Set([
  ".md",
  ".json",
  ".toml",
  ".rules",
  ".py",
  ".js",
  ".sh",
  ".txt",
  ".yaml",
  ".yml",
  ".jsonl",
]);

interface AssetGroup {
  id: string;
  name: string;
  description: string;
  files: AssetFile[];
}

interface AssetFileBase {
  key: string;
  name: string;
  path: string;
  displayPath: string;
  exists: boolean;
  size: number;
  mtime: number | null;
  editable: boolean;
}

type StatusLevel = "active" | "conditional" | "inactive" | "auto" | "config";

interface AssetStatus {
  level: StatusLevel;
  label: string;
  reason: string;
}

interface AssetFile extends AssetFileBase {
  status: AssetStatus;
}

interface BackupEntry {
  id: string;
  key: string;
  originalPath: string;
  originalExisted: boolean;
  createdAt: number;
  size: number;
  file: string;
}

function displayPath(filePath: string): string {
  const relative = path.relative(HOME, filePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join("/")}`;
  }
  return filePath.replace(/\\/g, "/");
}

function keyOf(filePath: string): string {
  return path.relative(CODEX_HOME, filePath).split(path.sep).join("/");
}

function isAllowedKey(key: string): boolean {
  const normalized = key.replace(/\\/g, "/");
  if (!normalized || normalized.includes("..") || path.isAbsolute(normalized)) {
    return false;
  }
  return ALLOWED_KEYS.some(
    (allowed) =>
      normalized === allowed || normalized.startsWith(`${allowed}/`),
  );
}

function resolveKey(key: string): string {
  if (!isAllowedKey(key)) throw new Error("不允许访问这个路径");
  const full = path.resolve(CODEX_HOME, key);
  const root = path.resolve(CODEX_HOME) + path.sep;
  if (!full.startsWith(root)) throw new Error("路径越界");
  return full;
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

async function ensureDir(dir: string) {
  await fsp.mkdir(dir, { recursive: true });
}

async function makeFileEntry(filePath: string): Promise<AssetFileBase> {
  const stat = await statSafe(filePath);
  const ext = path.extname(filePath).toLowerCase();
  return {
    key: keyOf(filePath),
    name: path.basename(filePath),
    path: filePath,
    displayPath: displayPath(filePath),
    exists: Boolean(stat?.isFile()),
    size: stat?.isFile() ? stat.size : 0,
    mtime: stat?.mtimeMs ?? null,
    editable: EDITABLE_EXTENSIONS.has(ext) || ext === "",
  };
}

async function walkFiles(
  root: string,
  match: (name: string) => boolean,
  maxDepth: number,
  limit: number,
): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string, depth: number) {
    if (result.length >= limit) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.length >= limit) return;
      if (entry.name.startsWith(".bak") || entry.name.endsWith(".bak")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) await walk(full, depth + 1);
      } else if (entry.isFile() && match(entry.name)) {
        result.push(full);
      }
    }
  }
  await walk(root, 0);
  return result;
}

function extractTomlValue(text: string, key: string): string | null {
  const pattern = new RegExp(
    `^\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`,
    "m",
  );
  const match = text.match(pattern);
  if (!match) return null;
  return (match[1] ?? match[2] ?? "").replace(/\\\\/g, "\\");
}

interface ClassifyContext {
  modelInstructionsFile: string | null;
  hookCommands: string[];
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

/** 从 hooks.json 里提取所有 command 字符串，用来判断脚本有没有被注册。 */
function extractHookCommands(text: string | null): string[] {
  if (!text) return [];
  try {
    const data = JSON.parse(text) as unknown;
    const commands: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
          if (key === "command" && typeof item === "string") commands.push(item);
          else walk(item);
        }
      }
    };
    walk(data);
    return commands;
  } catch {
    return [];
  }
}

function classifyAsset(
  groupId: string,
  file: AssetFileBase,
  ctx: ClassifyContext,
): AssetStatus {
  const key = file.key;

  if (key === "AGENTS.md") {
    return file.size > 0
      ? {
          level: "active",
          label: "生效",
          reason: "每次会话作为用户级 AGENTS.md 指令加载",
        }
      : { level: "inactive", label: "未生效", reason: "文件是空的" };
  }

  if (key === "system-prompt.md") {
    return samePath(ctx.modelInstructionsFile, file.path)
      ? {
          level: "active",
          label: "生效",
          reason: "config.toml 的 model_instructions_file 指向它",
        }
      : {
          level: "conditional",
          label: "待接入",
          reason: "config.toml 的 model_instructions_file 没指向它",
        };
  }

  if (key === "config.toml") {
    return {
      level: "config",
      label: "配置",
      reason: "提示词相关键的载体，不是提示词本身",
    };
  }

  if (groupId === "memory") {
    if (key === "memories/MEMORY.md") {
      return { level: "active", label: "生效", reason: "Codex memories 主记忆" };
    }
    if (key.endsWith("/raw_memories.md") || key.endsWith("/memory_summary.md")) {
      return {
        level: "auto",
        label: "自动维护",
        reason: "由 memories 功能生成 / 更新，通常不要手改",
      };
    }
    if (key.includes("/rollout_summaries/")) {
      return {
        level: "auto",
        label: "自动维护",
        reason: "自动生成的会话复盘摘要",
      };
    }
    if (key.includes("/extensions/")) {
      return {
        level: "active",
        label: "生效",
        reason: "memories 扩展指令，会被读取",
      };
    }
    if (key.includes("/skills/")) {
      return { level: "active", label: "生效", reason: "记忆技能，按需加载" };
    }
    return {
      level: "auto",
      label: "自动维护",
      reason: "由 memories 功能维护",
    };
  }

  if (groupId === "instructions") {
    return {
      level: "inactive",
      label: "未接入",
      reason: "Codex 不直接读取 instructions/，它只是提示词源文件",
    };
  }

  if (groupId === "rules") {
    return {
      level: "conditional",
      label: "条件生效",
      reason: "只有 VCO / hooks 运行时读取 rules/ 才生效",
    };
  }

  if (groupId === "hooks") {
    if (key === "hooks.json") {
      return {
        level: "active",
        label: "生效",
        reason: "Codex 生命周期钩子注册表",
      };
    }
    const normalize = (value: string) =>
      value.replace(/\\/g, "/").toLowerCase();
    const registered = ctx.hookCommands.some((command) =>
      normalize(command).includes(normalize(file.path)),
    );
    return registered
      ? {
          level: "active",
          label: "已注册",
          reason: "hooks.json 中有指向这个脚本的条目",
        }
      : {
          level: "inactive",
          label: "未注册",
          reason: "hooks.json 没有引用这个脚本",
        };
  }

  if (groupId === "prompts") {
    return {
      level: "active",
      label: "生效",
      reason: "斜杠命令模板，调用时作为提示词发送",
    };
  }

  if (groupId === "skills") {
    return { level: "active", label: "生效", reason: "技能提示词，按需加载" };
  }

  return { level: "auto", label: "未知", reason: "" };
}

function withStatus(
  groupId: string,
  file: AssetFileBase,
  ctx: ClassifyContext,
): AssetFile {
  return { ...file, status: classifyAsset(groupId, file, ctx) };
}

async function buildOverview() {
  const configText = (await readTextSafe(path.join(CODEX_HOME, "config.toml"))) ?? "";
  const hooksText = await readTextSafe(path.join(CODEX_HOME, "hooks.json"));
  const ctx: ClassifyContext = {
    modelInstructionsFile: extractTomlValue(configText, "model_instructions_file"),
    hookCommands: extractHookCommands(hooksText),
  };
  const rulesText =
    (await readTextSafe(path.join(CODEX_HOME, "rules", "default.rules"))) ?? "";
  const decisionCount = (decision: string) =>
    (rulesText.match(new RegExp(`decision\\s*=\\s*"${decision}"`, "g")) ?? [])
      .length;
  const windowsSandbox =
    configText.match(/\[windows\][\s\S]*?^\s*sandbox\s*=\s*"([^"]+)"/m)?.[1] ??
    null;
  const trustedProjects = [
    ...configText.matchAll(
      /\[projects\.'([^']+)'\]\s*\n\s*trust_level\s*=\s*"trusted"/g,
    ),
  ].map((match) => match[1]);
  let preToolUseHooks = 0;
  if (hooksText) {
    try {
      const parsed = JSON.parse(hooksText) as {
        hooks?: Record<string, Array<{ hooks?: unknown[] }>>;
      };
      for (const group of parsed.hooks?.PreToolUse ?? []) {
        preToolUseHooks += group.hooks?.length ?? 0;
      }
    } catch {
      // hooks.json 解析失败时保持 0
    }
  }
  const primary = (
    await Promise.all(
      ["AGENTS.md", "system-prompt.md"].map((key) =>
        makeFileEntry(path.join(CODEX_HOME, key)),
      ),
    )
  ).map((file) => withStatus("primary", file, ctx));
  const configFile = withStatus(
    "config",
    await makeFileEntry(path.join(CODEX_HOME, "config.toml")),
    ctx,
  );

  const groups: AssetGroup[] = [
    {
      id: "primary",
      name: "主提示词",
      description:
        "Codex 每次会话都会读取的位置。AGENTS.md 是用户级全局指令；system-prompt.md 只有在 config.toml 的 model_instructions_file 指向它时才替换基础系统提示。",
      files: primary,
    },
    {
      id: "config",
      name: "config.toml（提示词相关配置）",
      description:
        "model_instructions_file、developer_instructions、compact_prompt 等键都在这里。",
      files: [configFile],
    },
  ];

  const dirGroups: Array<{
    id: string;
    name: string;
    description: string;
    dir: string;
    match: (name: string) => boolean;
    maxDepth: number;
    limit: number;
  }> = [
    {
      id: "memory",
      name: "记忆",
      description:
        "Codex 的 memories 功能：MEMORY.md 主记忆、raw_memories.md 原始记录、memory_summary.md 摘要、rollout_summaries 会话复盘、extensions 临时指令。",
      dir: "memories",
      match: (name) => /\.(md|json|jsonl)$/i.test(name),
      maxDepth: 3,
      limit: 120,
    },
    {
      id: "instructions",
      name: "指令集",
      description:
        "gpt-contract、persona、unrestricted 等提示词包。Codex 原生不直接读这个目录，通常由安装器或手动粘贴使用。",
      dir: "instructions",
      match: (name) => /\.md$/i.test(name),
      maxDepth: 1,
      limit: 60,
    },
    {
      id: "rules",
      name: "规则",
      description:
        "rules/default.rules 以及 common、typescript 规则。第三方框架 / hooks 会读取这些规则。",
      dir: "rules",
      match: (name) => /\.(rules|md)$/i.test(name),
      maxDepth: 3,
      limit: 100,
    },
    {
      id: "hooks",
      name: "钩子与注入",
      description:
        "hooks.json 注册生命周期钩子；hooks/ 里的脚本会在 SessionStart、UserPromptSubmit 等时机注入提示词。",
      dir: "hooks",
      match: (name) => /\.(py|js|sh)$/i.test(name),
      maxDepth: 1,
      limit: 60,
    },
    {
      id: "prompts",
      name: "自定义命令",
      description:
        "prompts/*.md 是 Codex 的斜杠命令模板，调用时作为提示词发送。",
      dir: "prompts",
      match: (name) => /\.md$/i.test(name),
      maxDepth: 1,
      limit: 80,
    },
    {
      id: "skills",
      name: "技能（SKILL.md）",
      description:
        "skills/<名称>/SKILL.md 是按需加载的技能提示词。",
      dir: "skills",
      match: (name) => /^SKILL\.md$/i.test(name),
      maxDepth: 2,
      limit: 300,
    },
  ];

  for (const def of dirGroups) {
    const root = path.join(CODEX_HOME, def.dir);
    const files = await walkFiles(root, def.match, def.maxDepth, def.limit);
    groups.push({
      id: def.id,
      name: def.name,
      description: def.description,
      files: (
        await Promise.all(files.sort().map((file) => makeFileEntry(file)))
      ).map((file) => withStatus(def.id, file, ctx)),
    });
  }

  // hooks.json 单独挂在钩子组的最前面
  const hooksGroup = groups.find((group) => group.id === "hooks");
  if (hooksGroup) {
    hooksGroup.files.unshift(
      withStatus(
        "hooks",
        await makeFileEntry(path.join(CODEX_HOME, "hooks.json")),
        ctx,
      ),
    );
  }

  return {
    codexHome: CODEX_HOME,
    codexHomeDisplay: displayPath(CODEX_HOME),
    config: {
      modelInstructionsFile: ctx.modelInstructionsFile,
      developerInstructions: extractTomlValue(configText, "developer_instructions"),
      compactPrompt: extractTomlValue(configText, "compact_prompt"),
      experimentalCompactPromptFile: extractTomlValue(
        configText,
        "experimental_compact_prompt_file",
      ),
      projectDocMaxBytes: extractTomlValue(configText, "project_doc_max_bytes"),
      sandboxMode: extractTomlValue(configText, "sandbox_mode"),
      approvalPolicy: extractTomlValue(configText, "approval_policy"),
    },
    security: {
      sandboxMode: extractTomlValue(configText, "sandbox_mode"),
      approvalPolicy: extractTomlValue(configText, "approval_policy"),
      windowsSandbox,
      rules: {
        allow: decisionCount("allow"),
        deny: decisionCount("deny"),
        ask: decisionCount("ask"),
      },
      trustedProjects,
      preToolUseHooks,
    },
    groups,
    fileCount: groups.reduce((total, group) => total + group.files.length, 0),
  };
}

async function readFileAsset(key: string) {
  const full = resolveKey(key);
  const stat = await statSafe(full);
  if (!stat?.isFile()) throw new Error("文件不存在");
  if (stat.size > MAX_FILE_SIZE) throw new Error("文件超过 4 MB，无法在界面里编辑");
  return {
    key,
    path: full,
    displayPath: displayPath(full),
    size: stat.size,
    mtime: stat.mtimeMs,
    content: (await readTextSafe(full)) ?? "",
  };
}

async function readBackups(): Promise<BackupEntry[]> {
  return readJsonSafe<BackupEntry[]>(BACKUP_INDEX, []);
}

async function backupFile(key: string, filePath: string): Promise<BackupEntry> {
  const stat = await statSafe(filePath);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = `${id}.bak`;
  await ensureDir(BACKUP_ROOT);
  if (stat?.isFile()) await fsp.copyFile(filePath, path.join(BACKUP_ROOT, file));
  const entry: BackupEntry = {
    id,
    key,
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

async function saveFileAsset(key: string, content: string) {
  if (typeof content !== "string") throw new Error("缺少文件内容");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_SIZE) {
    throw new Error("内容超过 4 MB");
  }
  const full = resolveKey(key);
  const stat = await statSafe(full);
  const mode = stat?.isFile() ? stat.mode : undefined;
  const backup = await backupFile(key, full);
  await ensureDir(path.dirname(full));
  await fsp.writeFile(full, content, "utf8");
  if (mode !== undefined) {
    try {
      await fsp.chmod(full, mode);
    } catch {
      // Windows 上 chmod 只影响只读位，失败不影响内容
    }
  }
  return { backupId: backup.id, overview: await buildOverview() };
}

async function restoreBackup(id: string) {
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
  return { restored: entry, overview: await buildOverview() };
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
  if (!route.startsWith("/api/codex-assets/")) return false;

  try {
    if (req.method === "GET" && route === "/api/codex-assets/overview") {
      sendJson(res, 200, await buildOverview());
      return true;
    }
    if (req.method === "GET" && route === "/api/codex-assets/file") {
      const key = url.searchParams.get("key") ?? "";
      sendJson(res, 200, await readFileAsset(key));
      return true;
    }
    if (req.method === "GET" && route === "/api/codex-assets/backups") {
      sendJson(res, 200, (await readBackups()).slice(0, 80));
      return true;
    }
    if (req.method === "POST" && route === "/api/codex-assets/file") {
      const body = await readBody(req);
      const key = typeof body.key === "string" ? body.key : "";
      const content = typeof body.content === "string" ? body.content : "";
      sendJson(res, 200, await saveFileAsset(key, content));
      return true;
    }
    if (req.method === "POST" && route === "/api/codex-assets/restore") {
      const body = await readBody(req);
      const backupId = typeof body.backupId === "string" ? body.backupId : "";
      if (!backupId) throw new Error("缺少备份 ID");
      sendJson(res, 200, await restoreBackup(backupId));
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

export function codexAssetsPlugin(): Plugin {
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
    name: "cc-switch-codex-assets",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
