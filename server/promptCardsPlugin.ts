/**
 * 角色卡（网关侧提示词注入）后端 —— Vite 中间件。
 *
 * 这一层是**规格原型**，不是最终实现。`injectCard()` 写成不改入参的纯函数，
 * 目的是先在 TypeScript 里把三种协议的 system 槽、四种注入模式和幂等性写对，
 * 再原样翻成 cc-switch-src/src-tauri/src/proxy/prompt_card_injector.rs。
 *
 * 真正生效的位置是 Rust 代理的 forwarder.rs（请求改写环），不是这里。
 * 这个插件只负责：卡的增删改查、token 估算、把注入结果算给前端预览。
 *
 * 数据：~/.cc-switch/prompt-cards.json
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

// HANSHUANG_HOME 覆盖数据根（见 .env.hanshuang），便于把数据固定到非系统盘。
const HOME = process.env.HANSHUANG_HOME || os.homedir();
const CARDS_FILE = path.join(HOME, ".cc-switch", "prompt-cards.json");

/** 注入模式。`append` 不在原文档里，是 Claude Code 场景补的，理由见 MODE_NOTES。 */
export type CardMode = "fill" | "prepend" | "append" | "override";

/** 上游协议形态。决定 system 指令该往哪个字段塞。 */
export type Protocol = "anthropic" | "openai_chat" | "openai_responses";

export interface PromptCard {
  /** 稳定标识，会进模型名后缀，只允许 [a-z0-9-] */
  id: string;
  name: string;
  /** 注入正文 */
  system: string;
  /** 开场白，作为 assistant 消息注入；只在新会话注入 */
  firstMes: string;
  mode: CardMode;
  /** 缓存的 token 估算，写入时算一次，别在请求路径里现算 */
  tokenEstimate: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface CardStore {
  version: 1;
  /** 当前选中的卡；null = 不注入 */
  currentId: string | null;
  cards: PromptCard[];
}

const MODE_NOTES: Record<CardMode, string> = {
  fill: "用户自己带了 system 就完全不动。最保守，程序化调用不受影响。对 Claude Code 等于永不生效——它每个请求都带 system。",
  prepend:
    "插在用户 system 前面，用户的保留。注意：Anthropic 协议下会顶掉第一个 block 上的 cache_control 断点，每轮全价重发。",
  append:
    "追加到用户 system 后面。Claude Code 推荐这个——cache 断点在前面的 block 上，不受影响。",
  override: "扇掉用户的 system，只留卡。会废掉客户端自带的工具说明，谨慎。",
};

const EMPTY_STORE: CardStore = { version: 1, currentId: null, cards: [] };

// ───────────────────────────── 注入核心 ─────────────────────────────

/**
 * token 粗估。CJK 按 1 字 ≈ 1 token，其余按 4 字符 ≈ 1 token。
 * 只用于上下文预算和展示，不参与计费，不需要真分词。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[㐀-鿿぀-ヿ가-힯]/g) ?? [])
    .length;
  const rest = text.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

/** 把 Anthropic 的 system（string | block[] | 不存在）统一成 block 数组。 */
function toBlocks(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === "string") {
    return value ? [{ type: "text", text: value }] : [];
  }
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
    );
  }
  return [];
}

function blockText(block: Record<string, unknown>): string {
  return typeof block.text === "string" ? block.text : "";
}

/** 幂等标记：注入的 block 带上它，重试路径再跑一遍能认出自己。 */
function marker(card: PromptCard): string {
  return `<!-- cc-switch-card:${card.id} -->`;
}

function markedText(card: PromptCard): string {
  return `${marker(card)}\n${card.system}`;
}

export interface InjectResult {
  body: Record<string, unknown>;
  /** 这次调用实际有没有改东西 */
  injected: boolean;
  /** 没注入的原因，用于前端解释 */
  skipped: string | null;
}

/**
 * 按卡改写请求体的 system 槽。**不改入参**，返回新对象。
 *
 * 纯函数是为了重试安全：代理在 failover 时会用同一个原始 body 换 provider
 * 重发（见 forwarder.rs 里 `body.clone()` 的注释），原地修改会导致注入两次。
 */
export function injectCard(
  input: Record<string, unknown>,
  card: PromptCard | null,
  protocol: Protocol,
): InjectResult {
  if (!card) return { body: input, injected: false, skipped: "没有选中的卡" };
  if (!card.enabled)
    return { body: input, injected: false, skipped: "这张卡已停用" };
  if (!card.system.trim())
    return { body: input, injected: false, skipped: "卡的正文是空的" };

  const body = { ...input };
  const mark = marker(card);

  // ── Responses 协议：顶层 instructions 字符串 ──
  if (protocol === "openai_responses") {
    const existing =
      typeof body.instructions === "string" ? body.instructions : "";
    if (existing.includes(mark)) {
      return { body: input, injected: false, skipped: "已经注入过（幂等命中）" };
    }
    if (card.mode === "fill" && existing.trim()) {
      return {
        body: input,
        injected: false,
        skipped: "fill 模式：用户自带 instructions",
      };
    }
    const parts =
      card.mode === "override" || !existing.trim()
        ? [markedText(card)]
        : card.mode === "append"
          ? [existing, markedText(card)]
          : [markedText(card), existing];
    body.instructions = parts.join("\n\n");
    return { body, injected: true, skipped: null };
  }

  // ── Anthropic 协议：顶层 system，messages[] 里不许有 system 角色 ──
  if (protocol === "anthropic") {
    const blocks = toBlocks(body.system);
    if (blocks.some((block) => blockText(block).includes(mark))) {
      return { body: input, injected: false, skipped: "已经注入过（幂等命中）" };
    }
    if (card.mode === "fill" && blocks.length > 0) {
      return {
        body: input,
        injected: false,
        skipped: "fill 模式：用户自带 system（Claude Code 总是自带）",
      };
    }
    const own = { type: "text", text: markedText(card) };
    const next =
      card.mode === "override"
        ? [own]
        : card.mode === "append"
          ? [...blocks, own]
          : [own, ...blocks];
    body.system = next;
    body.messages = injectFirstMes(body.messages, card);
    return { body, injected: true, skipped: null };
  }

  // ── Chat 协议：messages[] 里一条 role:"system" ──
  const messages = Array.isArray(body.messages)
    ? (body.messages as Array<Record<string, unknown>>)
    : [];
  const isSystem = (msg: Record<string, unknown>) =>
    msg.role === "system" || msg.role === "developer";

  if (
    messages.some(
      (msg) =>
        isSystem(msg) &&
        typeof msg.content === "string" &&
        msg.content.includes(mark),
    )
  ) {
    return { body: input, injected: false, skipped: "已经注入过（幂等命中）" };
  }

  const hasOwn = messages.some(isSystem);
  if (card.mode === "fill" && hasOwn) {
    return {
      body: input,
      injected: false,
      skipped: "fill 模式：用户自带 system",
    };
  }

  // override 只删 system/developer，user/assistant 必须穿透——写成「删掉不是
  // user 的」会把整个对话历史弄没，单轮测试看不出来。
  const kept =
    card.mode === "override" ? messages.filter((msg) => !isSystem(msg)) : messages;

  const own = { role: "system", content: markedText(card) };
  let next: Array<Record<string, unknown>>;
  if (card.mode === "append" && hasOwn) {
    // 追加 = 插在最后一条 system 之后，不合并成一条
    const lastSystem = kept.reduce(
      (acc, msg, index) => (isSystem(msg) ? index : acc),
      -1,
    );
    next = [...kept.slice(0, lastSystem + 1), own, ...kept.slice(lastSystem + 1)];
  } else {
    next = [own, ...kept];
  }

  body.messages = injectFirstMes(next, card);
  return { body, injected: true, skipped: null };
}

/**
 * 开场白只在新会话注入。客户端发来的历史里可能已经包含它（用户看到过就会在
 * 历史里），不判断就会出现两次。
 */
function injectFirstMes(value: unknown, card: PromptCard): unknown {
  if (!card.firstMes.trim()) return value;
  if (!Array.isArray(value)) return value;
  const messages = value as Array<Record<string, unknown>>;
  const userTurns = messages.filter((msg) => msg.role === "user").length;
  if (userTurns > 1) return value;

  const greeting = { role: "assistant", content: card.firstMes };
  const firstUser = messages.findIndex((msg) => msg.role === "user");
  if (firstUser < 0) return [...messages, greeting];
  return [
    ...messages.slice(0, firstUser),
    greeting,
    ...messages.slice(firstUser),
  ];
}

// ───────────────────────────── 预览样本 ─────────────────────────────

/** 三个协议各一个样本请求，前端用来看注入前后的差别。 */
const SAMPLES: Record<Protocol, Record<string, unknown>> = {
  anthropic: {
    model: "claude-opus-5-5",
    max_tokens: 4096,
    stream: true,
    system: [
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: "把这个函数改成异步的" }],
    tools: [{ name: "Read", description: "Reads a file" }],
  },
  openai_chat: {
    model: "gpt-5",
    stream: true,
    messages: [
      { role: "system", content: "你是一个有帮助的助手。" },
      { role: "user", content: "在吗" },
    ],
  },
  openai_responses: {
    model: "gpt-5",
    stream: true,
    instructions: "你是一个有帮助的助手。",
    input: [{ role: "user", content: "在吗" }],
  },
};

const PROTOCOL_LABELS: Record<Protocol, string> = {
  anthropic: "/v1/messages（Claude Code）",
  openai_chat: "/v1/chat/completions",
  openai_responses: "/v1/responses",
};

// ───────────────────────────── 存储 ─────────────────────────────

async function readStore(): Promise<CardStore> {
  try {
    const text = await fsp.readFile(CARDS_FILE, "utf8");
    const parsed = JSON.parse(text) as Partial<CardStore>;
    return {
      version: 1,
      currentId: parsed.currentId ?? null,
      cards: Array.isArray(parsed.cards) ? parsed.cards : [],
    };
  } catch {
    return { ...EMPTY_STORE };
  }
}

async function writeStore(store: CardStore) {
  await fsp.mkdir(path.dirname(CARDS_FILE), { recursive: true });
  await fsp.writeFile(CARDS_FILE, JSON.stringify(store, null, 2), "utf8");
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

function uniqueId(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function normalizeMode(value: unknown): CardMode {
  return value === "fill" ||
    value === "prepend" ||
    value === "append" ||
    value === "override"
    ? value
    : "append";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 整个页面的数据：卡列表 + 当前卡的注入预览 + 元信息。 */
async function buildOverview() {
  const store = await readStore();
  const current = store.cards.find((card) => card.id === store.currentId) ?? null;

  const previews = (Object.keys(SAMPLES) as Protocol[]).map((protocol) => {
    const sample = SAMPLES[protocol];
    const result = injectCard(sample, current, protocol);
    return {
      protocol,
      label: PROTOCOL_LABELS[protocol],
      before: sample,
      after: result.body,
      injected: result.injected,
      skipped: result.skipped,
    };
  });

  return {
    file: CARDS_FILE,
    fileDisplay: `~/${path.relative(HOME, CARDS_FILE).split(path.sep).join("/")}`,
    currentId: store.currentId,
    cards: store.cards,
    modeNotes: MODE_NOTES,
    previews,
  };
}

async function saveCard(input: Record<string, unknown>) {
  const store = await readStore();
  const rawId = asString(input.id);
  const existingIndex = rawId
    ? store.cards.findIndex((card) => card.id === rawId)
    : -1;

  const name = asString(input.name).trim() || "未命名人物卡";
  const system = asString(input.system);
  const firstMes = asString(input.firstMes);
  const mode = normalizeMode(input.mode);
  const enabled = input.enabled !== false;

  if (system.length > 512 * 1024) throw new Error("卡的正文超过 512 KB");

  const now = Date.now();
  // token 估算在写入时算一次，存下来；请求路径上不再分词
  const tokenEstimate = estimateTokens(system) + estimateTokens(firstMes);

  if (existingIndex >= 0) {
    const previous = store.cards[existingIndex];
    store.cards[existingIndex] = {
      ...previous,
      name,
      system,
      firstMes,
      mode,
      enabled,
      tokenEstimate,
      updatedAt: now,
    };
    // 还没选卡时，改完这张就直接用它
    if (!store.currentId) store.currentId = previous.id;
  } else {
    const id = uniqueId(
      slugify(asString(input.id) || name, `card-${now.toString(36)}`),
      store.cards.map((card) => card.id),
    );
    store.cards.unshift({
      id,
      name,
      system,
      firstMes,
      mode,
      enabled,
      tokenEstimate,
      createdAt: now,
      updatedAt: now,
    });
    // 新建即启用：主界面「保存并开启」一次点击就生效，不用再回列表点选
    store.currentId = id;
  }

  await writeStore(store);
  return buildOverview();
}

async function deleteCard(id: string) {
  const store = await readStore();
  store.cards = store.cards.filter((card) => card.id !== id);
  if (store.currentId === id) store.currentId = store.cards[0]?.id ?? null;
  await writeStore(store);
  return buildOverview();
}

async function selectCard(id: string | null) {
  const store = await readStore();
  if (id && !store.cards.some((card) => card.id === id)) {
    throw new Error("这张卡不存在");
  }
  store.currentId = id;
  await writeStore(store);
  return buildOverview();
}

// ───────────────────────────── HTTP ─────────────────────────────

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2 * 1024 * 1024) throw new Error("请求体超过 2 MB");
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
  if (!route.startsWith("/api/prompt-cards")) return false;

  try {
    if (req.method === "GET" && route === "/api/prompt-cards/overview") {
      sendJson(res, 200, await buildOverview());
      return true;
    }

    if (req.method === "POST" && route === "/api/prompt-cards/save") {
      sendJson(res, 200, await saveCard(await readBody(req)));
      return true;
    }

    if (req.method === "POST" && route === "/api/prompt-cards/delete") {
      const body = await readBody(req);
      const id = asString(body.id);
      if (!id) throw new Error("缺少卡 id");
      sendJson(res, 200, await deleteCard(id));
      return true;
    }

    if (req.method === "POST" && route === "/api/prompt-cards/select") {
      const body = await readBody(req);
      const id = body.id === null ? null : asString(body.id);
      sendJson(res, 200, await selectCard(id || null));
      return true;
    }

    // 任意请求体试注入，用来验自测清单里的 role 过滤矩阵
    if (req.method === "POST" && route === "/api/prompt-cards/dry-run") {
      const body = await readBody(req);
      const store = await readStore();
      const cardId = asString(body.cardId) || store.currentId;
      const card = store.cards.find((item) => item.id === cardId) ?? null;
      const protocol = (asString(body.protocol) || "anthropic") as Protocol;
      const payload =
        typeof body.body === "object" && body.body !== null
          ? (body.body as Record<string, unknown>)
          : SAMPLES[protocol];
      const first = injectCard(payload, card, protocol);
      // 再跑一遍，证明幂等——重试路径上会真的发生
      const second = injectCard(first.body, card, protocol);
      sendJson(res, 200, {
        protocol,
        before: payload,
        after: first.body,
        injected: first.injected,
        skipped: first.skipped,
        idempotent: JSON.stringify(second.body) === JSON.stringify(first.body),
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

export function promptCardsPlugin(): Plugin {
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
    name: "cc-switch-prompt-cards",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
