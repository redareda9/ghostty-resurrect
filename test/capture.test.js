"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const ids = ["01234567-1111-4222-8333-123456789abc", "01234567-2222-4222-8333-123456789abc"];
const executable = path.resolve(__dirname, "../bin/ghostty-resurrect");

// Load the real capture functions with isolated OS data. The same harness can
// exercise the original CLI, which did not expose its functions as a module.
function loadModule(file, home, spawnSync) {
  const localRequire = createRequire(file);
  const context = { module: { exports: {} }, console, Buffer,
    process: { pid: process.pid, exit: (code) => { throw new Error(`Unexpected exit ${code}`); } },
    require: (name) => {
      if (["child_process", "node:child_process"].includes(name)) return { spawnSync };
      if (["os", "node:os"].includes(name)) return { ...os, homedir: () => home };
      if (name.startsWith(".")) return loadModule(localRequire.resolve(name), home, spawnSync);
      return localRequire(name);
    },
  };
  let source = fs.readFileSync(file, "utf8");
  if (file === executable) {
    source = source.slice(0, source.indexOf("// ---------- cli ----------"));
    source += "\nmodule.exports = { capture, save, resumeCmd, buildRestoreScript };";
  }
  vm.runInNewContext(source, context, { filename: file });
  return context.module.exports;
}

function fixture(t, { native = true, reverse = false, missing = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ghostty-capture-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessions = path.join(home, ".codex", "sessions", "2000", "01", "01");
  fs.mkdirSync(sessions, { recursive: true });
  const files = ids.map((id) => {
    const file = path.join(sessions, `rollout-2000-01-01T00-00-00-${id}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: "session_meta", payload: { id, cwd: "/project", source: "cli" } })}\n`);
    return file;
  });
  const command = native ? "/usr/local/bin/codex" : "/node_modules/@openai/codex/vendor/bin/codex";
  const procs = ids.map((id, i) => ({ pid: 10 + i, tty: `ttys00${i + 1}`, command, file: files[i] }));
  const ordered = reverse ? [...procs].reverse() : procs;
  const spawnSync = (command, args, options) => {
    let stdout;
    if (path.basename(command) === "osascript") {
      const script = options.input || fs.readFileSync(args[0], "utf8");
      const us = String.fromCharCode(31);
      stdout = `W\nT${us}1${us}same title\n` + procs.map((p) => {
        const fields = ["P", "/project", "same title"];
        if (script.includes("(pid of trm)")) fields.push(`terminal-${p.pid}`, p.pid, `/dev/${p.tty}`);
        return fields.join(us);
      }).join("\n");
    } else if (path.basename(command) === "ps") {
      stdout = args.includes("pid=,lstart=,command=")
        ? ordered.map((p) => `${p.pid} Fri Jan 1 00:00:00 2021 ${p.command}`).join("\n")
        : ordered.map((p) => `${p.pid} 1 ${p.pid} ${p.tty} ${p.command}`).join("\n");
    } else if (path.basename(command) === "lsof") {
      stdout = args.includes("-F0pfn")
        ? ordered.map((p) => `p${p.pid}\0\nfcwd\0n/project\0\n${missing ? "" : `f4\0n${p.file}\0\n`}`).join("")
        : ordered.map((p) => `p${p.pid}\nn/project\n`).join("");
    } else if (path.basename(command) === "stat") {
      stdout = "946684800\n";
    } else {
      throw new Error(`Unexpected subprocess: ${command}`);
    }
    return { status: 0, stdout, stderr: "" };
  };
  return { home, api: loadModule(executable, home, spawnSync) };
}

function capturedIds(api) {
  const snapshot = api.capture("latest");
  return JSON.parse(JSON.stringify(snapshot.windows[0].tabs[0].panes.map((p) => p.sessionId || p.tool)));
}

test("capture recognises native Codex binaries", (t) => {
  const { api } = fixture(t);
  assert.deepEqual(capturedIds(api), ids);
});

test("capture binds same-directory npm Codex panes independently of process order", (t) => {
  for (const reverse of [false, true]) {
    const { api } = fixture(t, { native: false, reverse });
    assert.deepEqual(capturedIds(api), ids);
  }
});

test("a capture without an open main transcript cannot overwrite the checkpoint", (t) => {
  const { home, api } = fixture(t, { missing: true });
  const store = path.join(home, ".config", "ghostty-resurrect");
  fs.mkdirSync(store, { recursive: true });
  const file = path.join(store, "latest.json");
  fs.writeFileSync(file, "previous checkpoint");
  assert.throws(() => api.save(api.capture("latest")), /expected one open main conversation/);
  assert.equal(fs.readFileSync(file, "utf8"), "previous checkpoint");
});

test("Codex restore requires an exact ID and preserves a quoted custom session store", (t) => {
  const { api } = fixture(t);
  assert.throws(() => api.resumeCmd({ tool: "codex" }), /valid conversation ID/);
  assert.throws(() => api.resumeCmd({ tool: "codex", sessionId: "$(touch unwanted)" }), /valid conversation ID/);
  assert.equal(api.resumeCmd({ tool: "codex", sessionId: ids[0], sessionHome: "/test/it's $(literal)" }),
    `CODEX_HOME='/test/it'\\''s $(literal)' codex resume ${ids[0]}`);
  const script = api.buildRestoreScript({ windows: [{ tabs: [{ panes: [{ tool: "codex", sessionId: ids[0], cwd: '/project/"quoted"' }] }] }] });
  assert.ok(script.includes('/project/\\"quoted\\"'));
  assert.ok(script.includes(`codex resume ${ids[0]}`));
  assert.doesNotMatch(script, /--last/);
});
