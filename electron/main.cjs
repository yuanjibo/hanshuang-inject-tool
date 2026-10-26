const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");

const PORT = 5190;
let serverProcess = null;
let mainWindow = null;
let quitting = false;

function serverEntry() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app", "server.mjs")
    : path.join(
        __dirname,
        "..",
        "release",
        "寒霜注入工具-1.0.0",
        "server.mjs",
      );
}

function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(__dirname, "..", "build", "icon.ico");
}

function portFree(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

async function ensurePortFree() {
  const free4 = await portFree(PORT, "127.0.0.1");
  const free6 = await portFree(PORT, "::1");
  if (!free4 || !free6) {
    throw new Error(
      `端口 ${PORT} 已被占用。请先关闭 pnpm dev 或另一个寒霜注入工具实例，再启动本程序。`,
    );
  }
}

function startServer() {
  const entry = serverEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(`找不到本地服务文件：${entry}`);
  }
  serverProcess = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(PORT),
      CARD_PROXY_PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  serverProcess.stdout.on("data", (chunk) => {
    process.stdout.write(`[server] ${chunk}`);
  });
  serverProcess.stderr.on("data", (chunk) => {
    process.stderr.write(`[server] ${chunk}`);
  });
  serverProcess.on("exit", (code) => {
    serverProcess = null;
    if (!quitting && code !== 0) {
      dialog.showErrorBox(
        "寒霜注入工具启动失败",
        `本地服务意外退出（代码 ${code}）。\n请检查端口 ${PORT} 是否被占用。`,
      );
      app.quit();
    }
  });
}

function waitForServer(timeoutMs = 20000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const request = http.get(`http://localhost:${PORT}/`, (response) => {
        response.resume();
        resolve();
      });
      request.on("error", () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error("本地服务启动超时。"));
        } else {
          setTimeout(tick, 200);
        }
      });
      request.setTimeout(1500, () => request.destroy());
    };
    tick();
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#f7f7f8",
    title: "寒霜注入工具",
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`http://localhost:${PORT}`)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });

  await mainWindow.loadURL(`http://localhost:${PORT}/`);
}

function stopServer() {
  if (!serverProcess) return;
  try {
    serverProcess.kill();
  } catch {
    // ignore
  }
  serverProcess = null;
}

app.whenReady().then(async () => {
  try {
    await ensurePortFree();
    startServer();
    await waitForServer();
    await createWindow();
  } catch (error) {
    dialog.showErrorBox(
      "寒霜注入工具启动失败",
      String(error && error.message ? error.message : error),
    );
    quitting = true;
    stopServer();
    app.quit();
  }
});

app.on("window-all-closed", () => {
  quitting = true;
  stopServer();
  app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  stopServer();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
