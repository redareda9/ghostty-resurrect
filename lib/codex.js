"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function run(command, args, options = {}) {
  const { allowedStatuses = [0], ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 15000, ...spawnOptions,
  });
  if (result.error || !allowedStatuses.includes(result.status)) {
    throw new Error(`${command} failed: ${result.error?.message || result.stderr?.trim() || result.status}`);
  }
  return result.stdout;
}

function parseProcesses(output) {
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (!match) return [];
    const [, pid, ppid, pgid, tty, command] = match;
    const name = path.basename(command);
    return [{ pid: +pid, ppid: +ppid, pgid: +pgid, tty, command,
      tool: name === "codex" ? name : null }];
  });
}

function processes() {
  return parseProcesses(run("/bin/ps", ["-axww", "-o", "pid=,ppid=,pgid=,tty=,comm="]));
}

function descendants(pid, procs) {
  const ids = new Set([pid]);
  let size;
  do {
    size = ids.size;
    for (const p of procs) if (ids.has(p.ppid)) ids.add(p.pid);
  } while (size !== ids.size);
  return ids;
}

function parseOpenFiles(output) {
  const result = new Map();
  let record, descriptor;
  for (const raw of output.split("\0")) {
    const field = raw.replace(/^\n+/, "");
    if (field[0] === "p") {
      record = { files: [], cwd: null };
      result.set(Number(field.slice(1)), record);
      descriptor = null;
    } else if (field[0] === "f") {
      descriptor = field.slice(1);
    } else if (field[0] === "n" && record) {
      if (descriptor === "cwd") record.cwd = field.slice(1);
      else record.files.push(field.slice(1));
    }
  }
  return result;
}

function openFiles(pids) {
  if (!pids.length) return new Map();
  // A selected child can exit during enumeration. Missing agent evidence is
  // rejected by resolveAgent, so a partial lsof listing cannot invent a match.
  return parseOpenFiles(run("/usr/sbin/lsof", ["-nP", "-a", "-p", pids.join(","), "-F0pfn"], { allowedStatuses: [0, 1] }));
}

// Metadata can contain long instructions. Bound reads without loading transcripts.
function readHeader(file) {
  const fd = fs.openSync(file, "r");
  try {
    const chunks = [];
    let length = 0;
    while (length < 2 * 1024 * 1024) {
      const chunk = Buffer.alloc(32768);
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      const end = chunk.subarray(0, count).indexOf(10);
      chunks.push(chunk.subarray(0, end < 0 ? count : end));
      length += count;
      if (end >= 0) return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    throw new Error(`Incomplete or oversized session metadata: ${file}`);
  } finally {
    fs.closeSync(fd);
  }
}

function sessionFromFile(file, header = readHeader) {
  const name = path.basename(file);
  const match = name.match(/^rollout-.*-([0-9a-f-]{36})\.jsonl$/i);
  if (!match || !UUID.test(match[1])) return null;
  const entry = header(file);
  const meta = entry.payload;
  if (entry.type !== "session_meta" || !meta || meta.id !== match[1]) {
    throw new Error(`Invalid Codex session metadata: ${file}`);
  }
  if (meta.source !== "cli" || meta.parent_thread_id) return null;
  if (!path.isAbsolute(meta.cwd || "")) throw new Error(`Missing session directory: ${file}`);
  const boundary = file.lastIndexOf("/sessions/");
  if (boundary < 0) throw new Error(`Unknown Codex session storage: ${file}`);
  return { sessionId: meta.id, cwd: meta.cwd, sessionFile: file, sessionHome: file.slice(0, boundary) || "/" };
}

function resolveAgent(agent, procs, files, header = readHeader) {
  const ids = descendants(agent.pid, procs);
  const paths = new Set([...ids].flatMap((pid) => files.get(pid)?.files || []));
  const sessions = new Map();
  for (const file of paths) {
    const session = sessionFromFile(file, header);
    if (session) sessions.set(session.sessionId, session);
  }
  if (sessions.size !== 1) {
    throw new Error(`${agent.tool} PID ${agent.pid}: expected one open main conversation, found ${sessions.size}; previous backup retained`);
  }
  return { ...sessions.values().next().value, tool: agent.tool, processId: agent.pid };
}

function resolvePane(pane, procs, files, header = readHeader) {
  const foreground = procs.find((p) => p.pid === pane.pid);
  if (!foreground) throw new Error(`Pane ${pane.terminalId}: foreground process disappeared; retry backup`);
  if (`/dev/${foreground.tty}` !== pane.tty) throw new Error(`Pane ${pane.terminalId}: terminal identity changed; retry backup`);
  const ids = descendants(foreground.pid, procs);
  const candidates = procs.filter((p) => ids.has(p.pid) && p.pgid === foreground.pgid && p.tool);
  const roots = candidates.filter((p) => !candidates.some((other) => other.pid !== p.pid && descendants(other.pid, procs).has(p.pid)));
  if (roots.length > 1) throw new Error(`Pane ${pane.terminalId}: ambiguous agent processes; previous backup retained`);
  if (!roots.length) return null;
  const session = resolveAgent(roots[0], procs, files, header);
  return { ...pane, ...session, cwd: session.cwd || files.get(roots[0].pid)?.cwd || pane.cwd };
}

function inspectProcesses(procs = processes()) {
  const ids = new Set();
  for (const p of procs) if (p.tool) for (const id of descendants(p.pid, procs)) ids.add(id);
  return { procs, files: openFiles([...ids]) };
}

module.exports = { UUID, run, parseProcesses, processes, descendants, parseOpenFiles,
  openFiles, readHeader, sessionFromFile, resolveAgent, resolvePane, inspectProcesses };
