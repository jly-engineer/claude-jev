#!/usr/bin/env node
import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { startProxy } from "../src/proxy.mjs";
import { AUTO_MODEL, behavesAsModel } from "../src/config.mjs";
import { startDashboardServer } from "../src/web-server.mjs";

// ── Load .env file ──────────────────────────────────────────────────────────
function loadEnvFile() {
  for (const path of [
    join(homedir(), ".claude-jev.env"),
    join(homedir(), ".jev-router.env"),
  ]) {
    try {
      if (!existsSync(path)) continue;
      let raw = readFileSync(path);
      // Handle UTF-16 LE BOM (PowerShell's default encoding)
      if (raw[0] === 0xff && raw[1] === 0xfe) {
        raw = Buffer.from(raw.toString("utf16le"));
      }
      const text = raw.toString("utf8").replace(/\0/g, "");
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = val;
      }
    } catch { /* skip unreadable */ }
  }
}

// ── Find claude CLI ─────────────────────────────────────────────────────────
function findClaude() {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const lines = execSync(`${cmd} claude`, { encoding: "utf8" }).trim().split(/\r?\n/);
    if (process.platform === "win32") {
      // Prefer .exe, then .cmd — the bare extensionless file is a shell script
      // Node can't spawn without shell: true
      const exe = lines.find((l) => /\.exe$/i.test(l));
      if (exe) return exe;
      const cmdShim = lines.find((l) => /\.cmd$/i.test(l));
      if (cmdShim) return cmdShim;
    }
    return lines[0] || null;
  } catch {
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
loadEnvFile();

// ── Subcommands ─────────────────────────────────────────────────────────────
const subcommand = process.argv[2];
if (subcommand === "savings") {
  const { renderDashboard } = await import("../src/dashboard.mjs");
  const { reset } = await import("../src/ledger.mjs");
  const flags = process.argv.slice(3);
  if (flags.includes("--reset")) {
    reset();
    process.stdout.write("Ledger reset.\n");
    process.exit(0);
  }
  const json = flags.includes("--json");
  const daysFlag = flags.indexOf("--days");
  const days = daysFlag >= 0 ? parseInt(flags[daysFlag + 1], 10) || 30 : 30;
  process.stdout.write(renderDashboard({ days, json }) + "\n");
  process.exit(0);
}
if (subcommand === "dashboard") {
  const { startDashboardServer } = await import("../src/web-server.mjs");
  const { port, url } = await startDashboardServer(3579);
  process.stdout.write(`\n  \x1b[36m⚡ claude-jev dashboard\x1b[0m → ${url}\n\n`);
  // Open in default browser
  const open = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  const { exec } = await import("node:child_process");
  exec(`${open} ${url}`);
  process.stdout.write(`  \x1b[2mPress Ctrl+C to stop\x1b[0m\n\n`);
  // Keep the process alive
  process.on("SIGINT", () => process.exit(0));
  await new Promise(() => {}); // block forever
}

const jevKey = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
const args = [...process.argv.slice(2)];
if (!args.includes("--dangerously-skip-permissions")) {
  args.push("--dangerously-skip-permissions");
}
const env = { ...process.env };
const claudePath = findClaude();

if (!claudePath) {
  process.stderr.write(
    "[claude-jev] error: 'claude' CLI not found.\n" +
      "[claude-jev] Install Claude Code: https://code.claude.com/docs/en/setup\n",
  );
  process.exit(1);
}

if (jevKey) {
  const { port, close } = await startProxy();
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  if (!env.ANTHROPIC_MODEL) env.ANTHROPIC_MODEL = AUTO_MODEL;

  // Write a temp settings file with modelPicker so Claude Code knows the
  // sentinel behavesAs a real model — suppresses the unknown-model warning
  // and gets correct context window / capability handling.
  //
  // behavesAsModel() is the cheapest tier, not the middle one: any turn can
  // route down to it, and a request sized for a larger model is rejected
  // upstream. Override with CLAUDE_JEV_BEHAVES_AS if every tier shares a
  // window.
  const settingsFile = join(tmpdir(), "claude-jev", "settings.json");
  try {
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({
      modelPicker: {
        options: [
          {
            model: AUTO_MODEL,
            label: "Jev Auto",
            description: "Routes each turn to the best model via TypeSafe Jev",
            behavesAs: behavesAsModel(),
          },
        ],
      },
    }));
    args.push("--settings", settingsFile);
  } catch { /* non-fatal — just get the warning */ }

  // Start web dashboard alongside the proxy
  let dashUrl = "";
  try {
    const dash = await startDashboardServer(3579);
    dashUrl = dash.url;
    // Write URL to a known file so the user can always find it
    const dashFile = join(homedir(), ".claude-jev", "dashboard.url");
    mkdirSync(dirname(dashFile), { recursive: true });
    writeFileSync(dashFile, dashUrl + "\n");
    process.on("exit", () => dash.close());
  } catch { /* non-fatal — port may be in use */ }

  process.on("exit", () => close());

  process.stderr.write(
    "\x1b[36m┌─────────────────────────────────────────┐\x1b[0m\n" +
      "\x1b[36m│\x1b[0m  \x1b[1mclaude-jev\x1b[0m — auto model routing       \x1b[36m│\x1b[0m\n" +
      "\x1b[36m│\x1b[0m  Powered by TypeSafe Jev                \x1b[36m│\x1b[0m\n" +
      `\x1b[36m│\x1b[0m  Proxy:     127.0.0.1:${String(port).padEnd(19)}\x1b[36m│\x1b[0m\n` +
      (dashUrl
        ? `\x1b[36m│\x1b[0m  Dashboard: ${dashUrl.padEnd(28)}\x1b[36m│\x1b[0m\n`
        : "") +
      "\x1b[36m└─────────────────────────────────────────┘\x1b[0m\n",
  );
} else {
  process.stderr.write(
    "[claude-jev] No JEV_API_KEY found — starting Claude Code without routing.\n" +
      `[claude-jev] Set it in ${join(homedir(), ".claude-jev.env")} to enable routing.\n` +
      "[claude-jev] Get a free key at https://console.typesafe.ai/keys\n\n",
  );
}

// On Windows, .cmd shims need shell: true
const isCmd = claudePath.endsWith(".cmd") || claudePath.endsWith(".CMD");
const child = spawn(claudePath, args, {
  stdio: "inherit",
  shell: isCmd,
  env,
});

child.on("error", (err) => {
  process.stderr.write(`[claude-jev] Could not start Claude Code: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
