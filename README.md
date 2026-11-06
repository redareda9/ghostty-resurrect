# ghostty-resurrect

Back up and restore your [Ghostty](https://ghostty.org) terminal layout **and the Claude Code / Codex CLI sessions running inside it.** Restart your Mac without losing a single agent conversation.

Think `tmux-resurrect`, but for Ghostty's native windows/tabs/splits — and it knows how to bring your AI coding agents back to life.

```
ghostty-resurrect backup     # before you restart
#  ... reboot ...
ghostty-resurrect restore    # tabs, panes, and every Claude/Codex session resumed
```

## Why

Ghostty has no session persistence — quit it and your carefully arranged tabs and panes are gone. If those panes were running long-lived `claude` or `codex` sessions, you lose all that context too. `ghostty-resurrect` snapshots the whole layout, figures out which resumable session each pane is running, and rebuilds everything on demand, auto-running `claude --resume <id>` / `codex resume <id>` in each pane.

## What it captures

- Every Ghostty **window → tab → pane**, with each pane's working directory and title
- For each pane, whether it's a **Claude Code** session, a **Codex** session, or a plain shell
- The **resumable session id** for each agent pane

## How it works

No daemon, no shell hooks, no wrappers around your agents. It reconstructs everything from what's already on disk at backup time:

1. **Layout** comes from Ghostty's AppleScript dictionary: windows, tabs, terminals, working directories, titles and each terminal's foreground PID and TTY (added in Ghostty 1.4.0).
2. **Codex conversations** are matched by foreground process and TTY, then by the main transcript open in that process tree. Only the metadata header is read, with a 2 MiB limit. This handles standalone binaries, launcher/app-server children and old resumed or forked conversations without searching historical transcripts. Sub-agent transcripts are excluded. Claude retains its existing process start-time/transcript birth-time and `aiTitle` matching.
3. **Restore** uses Ghostty's scripting verbs (`new window`, `new tab`, `split`) with a surface configuration that sets the pane's `initial working directory` and an `initial input` of the resume command — so each pane opens in the right place and resumes itself.

## Requirements

- **macOS** (uses AppleScript + `lsof`/`ps`/`stat`)
- **Ghostty 1.4.0 or newer** (foreground PID and TTY in the AppleScript scripting dictionary)
- **Node 18 or newer** or **[Bun](https://bun.sh)** - the CLI has no package dependencies; keep the adjacent `lib` directory when symlinking it
- [Claude Code](https://www.claude.com/product/claude-code) and/or [Codex CLI](https://developers.openai.com/codex/cli) if you want session resume (layout backup works without them)

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

Codex captures require one identifiable open main transcript for each foreground Codex pane. An empty new session, missing transcript, process race or ambiguous identity fails the capture before replacing the previous backup. Start a resumable conversation or resolve the ambiguity, then retry. A saved Codex pane without a valid conversation ID cannot be restored; take a new backup instead of resuming an unrelated latest conversation.

Codex restoration uses the project directory recorded in the transcript and preserves a custom `CODEX_HOME` when present. Terminal scrollback, process memory and running commands are not captured.

## Tests

Run `npm test` for the dependency-free Node test suite. Fixtures cover native and npm binaries, process trees, same-directory panes, resumed and forked conversations, sub-agents, uncertain identities and bounded metadata reads. Tests isolate their filesystem and process data from live sessions.

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
