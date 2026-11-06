"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseProcesses, parseOpenFiles, readHeader, sessionFromFile, resolvePane } = require("../lib/codex");

const idA = "01234567-1111-4222-8333-123456789abc";
const idB = "01234567-2222-4222-8333-123456789abc";
const fileFor = (id) => `/sessions/2000/01/01/rollout-2000-01-01T00-00-00-${id}.jsonl`;
const agent = (pid, tty = "ttys001", extra = {}) => ({ pid, ppid: 1, pgid: pid, tty, tool: "codex", ...extra });
const pane = (pid = 10) => ({ pid, tty: "/dev/ttys001", terminalId: `terminal-${pid}`, cwd: "/stale-shell-cwd", title: "same title" });
const header = (file) => ({ type: "session_meta", payload: { id: file.includes(idA) ? idA : idB, cwd: "/project", source: "cli", forked_from_id: "old-session" } });

test("recognises standalone, native and npm-installed binaries without matching similar names", () => {
  const procs = parseProcesses("10 1 10 ttys001 codex\n11 1 11 ttys002 /Users/test/.local/bin/aarch64/codex\n12 1 12 ttys003 /node_modules/@openai/codex/vendor/bin/codex\n13 1 13 ?? /Applications/Some App.app/bin/claude\n14 1 14 ?? codex-helper\n15 1 15 ?? node");
  assert.deepEqual(procs.map((p) => p.tool), ["codex", "codex", "codex", null, null, null]);
});

test("maps same-directory, same-title conversations independently of process order", () => {
  const procs = [agent(10), agent(20, "ttys002")];
  const files = new Map([[10, { files: [fileFor(idA)] }], [20, { files: [fileFor(idB)] }]]);
  for (const order of [procs, [...procs].reverse()]) {
    assert.equal(resolvePane(pane(), order, files, header).sessionId, idA);
    assert.equal(resolvePane({ ...pane(20), tty: "/dev/ttys002" }, order, files, header).sessionId, idB);
  }
});

test("resumed and forked main sessions use transcript identity and project directory", () => {
  const result = resolvePane(pane(), [agent(10)], new Map([[10, { files: [fileFor(idA)] }]]), header);
  assert.equal(result.sessionId, idA);
  assert.equal(result.cwd, "/project");
});

test("follows a launcher and app-server child without selecting sub-agent transcripts", () => {
  const procs = [agent(10, "ttys001", { tool: null }), agent(11, "ttys001", { ppid: 10, pgid: 10 }), agent(12, "??", { ppid: 11, pgid: 10 })];
  const files = new Map([[12, { files: [fileFor(idA), fileFor(idB)] }]]);
  const metadata = (file) => file.includes(idA) ? header(file) : { type: "session_meta", payload: { id: idB, source: { subagent: {} }, parent_thread_id: idA } };
  assert.equal(resolvePane(pane(), procs, files, metadata).sessionId, idA);
});

test("never substitutes the newest conversation when evidence is missing or ambiguous", () => {
  assert.throws(() => resolvePane(pane(), [agent(10)], new Map(), header), /found 0/);
  assert.throws(() => resolvePane(pane(), [agent(10)], new Map([[10, { files: [fileFor(idA), fileFor(idB)] }]]), header), /found 2/);
});

test("rejects process races and terminal reuse", () => {
  assert.throws(() => resolvePane(pane(), [], new Map(), header), /disappeared/);
  assert.throws(() => resolvePane(pane(), [agent(10, "ttys099")], new Map(), header), /identity changed/);
});

test("a background agent does not turn a foreground shell into an agent pane", () => {
  const procs = [agent(10, "ttys001", { tool: null }), agent(11, "ttys001", { ppid: 10 })];
  assert.equal(resolvePane(pane(), procs, new Map(), header), null);
});

test("parses NUL-delimited lsof paths without losing spaces or embedded newlines", () => {
  const files = parseOpenFiles("p10\0\nfcwd\0n/project with spaces\0\nf4\0n/path/with\nnewline\0\np20\0\nf3\0n/another\0\n");
  assert.deepEqual(files.get(10), { cwd: "/project with spaces", files: ["/path/with\nnewline"] });
  assert.deepEqual(files.get(20).files, ["/another"]);
});

test("reads long metadata but rejects truncated or mismatched headers", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghostty-resurrect-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "header.jsonl");
  const entry = { ...header(fileFor(idA)), padding: "x".repeat(100000) };
  fs.writeFileSync(file, `${JSON.stringify(entry)}\n${"not JSON".repeat(10000)}`);
  assert.equal(readHeader(file).payload.id, idA);
  fs.writeFileSync(file, '{"type":');
  assert.throws(() => readHeader(file), /Incomplete/);
  assert.throws(() => sessionFromFile(fileFor(idA), () => header(fileFor(idB))), /Invalid/);
});
