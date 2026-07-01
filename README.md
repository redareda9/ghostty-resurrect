# ghostty-resurrect

Back up and restore your [Ghostty](https://ghostty.org) terminal layout **and the Claude Code / Codex / Amp CLI sessions running inside it.** Restart your Mac without losing a single agent conversation.

Think `tmux-resurrect`, but for Ghostty's native windows/tabs/splits — and it knows how to bring your AI coding agents back to life.

```
ghostty-resurrect backup     # before you restart
#  ... reboot ...
ghostty-resurrect restore    # tabs, panes, and every Claude/Codex/Amp session resumed
```

## Why

Ghostty has no session persistence — quit it and your carefully arranged tabs and panes are gone. If those panes were running long-lived `claude`, `codex`, or `amp` sessions, you lose all that context too. `ghostty-resurrect` snapshots the whole layout, figures out which resumable session each pane is running, and rebuilds everything on demand, auto-running `claude --resume <id>` / `codex resume <id>` / `amp threads continue <id>` in each pane.

## What it captures

- Every Ghostty **window → tab → pane**, with each pane's working directory and title
- For each pane, whether it's a **Claude Code** session, a **Codex** session, an **Amp** session, or a plain shell
- The **resumable session id** for each agent pane

## How it works

No daemon, no shell hooks, no wrappers around your agents. It reconstructs everything from what's already on disk at backup time:

1. **Layout** comes from Ghostty's AppleScript dictionary (added in Ghostty 1.3.0): windows, tabs, terminals, working directories, titles.
2. **Pane → session** is the hard part. Each running `claude`/`codex` process is matched to its on-disk session transcript by **start-time ≈ transcript birth-time**. For Claude, the pane's live title is then matched against the transcript's `aiTitle` field, which makes the mapping authoritative even when several sessions share one directory. For **Amp**, the mapping is exact: each running `amp` process holds its thread log (`~/.cache/amp/logs/threads/T-<id>.log`) open, so `lsof` reveals the thread id directly — no heuristics. The thread title is read from `~/.local/share/amp/threads/T-<id>.json` (or the open log for not-yet-flushed active threads).
3. **Restore** uses Ghostty's scripting verbs (`new window`, `new tab`, `split`) with a surface configuration that sets the pane's `initial working directory` and an `initial input` of the resume command — so each pane opens in the right place and resumes itself.

## Requirements

- **macOS** (uses AppleScript + `lsof`/`ps`/`stat`)
- **Ghostty ≥ 1.3.0** (the AppleScript scripting dictionary)
- **Node ≥ 18** or **[Bun](https://bun.sh)** — the CLI is a single dependency-free script
- [Claude Code](https://www.claude.com/product/claude-code), [Codex CLI](https://developers.openai.com/codex/cli), and/or [Amp](https://ampcode.com) if you want session resume (layout backup works without them)

## Install

```sh
npm install -g ghostty-resurrect
# or
bun install -g ghostty-resurrect
```

Or just clone and symlink the script anywhere on your `PATH`:

```sh
git clone https://github.com/redareda9/ghostty-resurrect.git
ln -s "$PWD/ghostty-resurrect/bin/ghostty-resurrect" ~/bin/ghostty-resurrect
```

The first time you run it, macOS will ask for permission to let your terminal control Ghostty (System Settings → Privacy & Security → Automation).

## Usage

```sh
ghostty-resurrect backup [name]              # snapshot current layout + sessions (default name: "latest")
ghostty-resurrect restore [name]             # reopen Ghostty with the saved layout, resume each session
ghostty-resurrect restore [name] --dry-run   # print the AppleScript it would run, without running it
ghostty-resurrect list                       # list saved snapshots
ghostty-resurrect show [name]                # print a snapshot
```

Example:

```
$ ghostty-resurrect backup
Window 1
  Tab 1: migrate-logs-to-axiom
     - [claude efa2d5f9] migrate-logs-to-axiom
     - [claude 121511b5] Find best table at Ojo Mexican restaurant
  Tab 2 *: api refactor
     - [codex 019eddf6] api refactor
     - [shell] ~/src/web

1 window(s), 4 pane(s), 3 agent session(s).

Saved -> ~/.config/ghostty-resurrect/latest.json
```

Snapshots are plain JSON in `~/.config/ghostty-resurrect/` — easy to inspect, edit, or commit.

## Claude Code skills (optional)

If you use Claude Code, drop the bundled skills into `~/.claude/skills/` so you can just say **"backup"** or **"restore"** in any session:

```sh
cp -r skills/backup skills/restore ~/.claude/skills/
```

## Limitations (v1)

- **Split geometry is approximate.** Panes are recreated as an even left-to-right split chain. The *number* of panes per tab and every session resume correctly, but a complex nested split arrangement won't be pixel-identical. (Exact geometry via the macOS Accessibility API is on the roadmap.)
- **Resuming duplicates a live session.** Restore is meant for the *quit → reboot → restore* flow. Running it while the original sessions are still open will start second processes against the same session files.
- On-screen window position/size isn't restored.
- macOS + Ghostty only.

## Prior art

- [`gtab`](https://github.com/Franvy/gtab) — Ghostty workspace/layout manager (saves tabs, splits, working dirs). It captures split geometry via Accessibility but does **not** restore running processes or agent sessions. `ghostty-resurrect` focuses on the session-resume half.
- [`tmux-resurrect`](https://github.com/tmux-plugins/tmux-resurrect) — the inspiration, for tmux.

## License

MIT © Reda ([@redareda9](https://github.com/redareda9))
