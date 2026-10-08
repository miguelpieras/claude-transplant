# Claude Transplant Resume

Move local Claude Desktop Code conversations to a verified Personal plan, then resume interrupted work.

**Unofficial macOS beta.** This is a fork of [Claude Transplant by Vitaliy Hayda](https://github.com/vitaliyhayda/claude-transplant), based on upstream 4.1.2. The original MIT license and copyright remain in [LICENSE](LICENSE).

## Install

Requires macOS 13 or later, Node.js 22 or later, Claude Desktop, and the Xcode command line tools (`xcode-select --install`).

```sh
npm install -g github:miguelpieras/claude-transplant#v4.1.3-resume.1
claude-transplant-resume menubar
```

The app starts at login. Open **Claude Transplant Resume** from the menu bar. The GitHub tag is the release source; this fork is not published to the npm registry.

The fork has its own command, app identity, and settings directory. Quit the original Claude Transplant app before using this fork. Do not run two migration tools at the same time. Finish or cancel any pending move in the original app first.

## Use

1. Select the source account and plan that hold your conversations. Click **Use these conversations**. This selects all local conversation records in that source, including records with no local transcript.
2. Sign into the destination in **Claude Desktop** and select its **Personal Max or Personal Pro** plan. A terminal Claude Code login does not change the Desktop account.
3. Check the source, destination, and record count shown in the panel. New signed-in accounts can appear before they have any conversations. If an account shows only an ID, sign into it in Claude Desktop once so the app can read its name.
4. Click **Move and resume**. Claude closes briefly, the local records move, and Claude opens again. Clear **Resume stopped conversations** for a move without continuation messages.
5. Read the result and open **Details** for any conversation that needs attention.

The collection follows its last destination. New conversations created there join the next move. Conversations that were already in a destination before the move stay there if you later move the collection away. **Accounts → Choose a different source** explicitly starts a new collection from all records in that account and plan.

To move back, sign into the previous Personal plan and use the same button. The inherited CLI `undo` command uses different receipts and is disabled once a collection has been selected.

### Resume behavior

The app considers unfinished conversations active in the last 24 hours. It excludes archived conversations, scheduled runs, and conversations that already report a request for user input. It sends this message through Claude Desktop:

> Continue the existing task from where it stopped. Check the result of any interrupted command or pending check before running it again. Keep the existing scope and instructions.

Running conversations and unsent drafts are left alone. The app checks the selected account and conversation. A missing or duplicate sidebar title requires manual action. English Claude Desktop controls are required for this beta.

The result confirms new assistant activity or a visible running state. It does **not** prove that the conversation's task has finished. A resumed conversation can still reach a usage limit, request approval, or need other input. Continuation requests use the selected Claude plan's allowance.

## macOS permissions

Automatic resume needs **System Settings → Privacy & Security → Accessibility → Claude Transplant Resume**. The app requests access before a resume operation. Move-only operation does not need Accessibility access.

If the app is absent from the list, click **Open app folder** in its permission message, then add the app with the `+` button in System Settings. Its installed location is:

```text
~/Library/Application Support/claude-transplant-resume/Claude Transplant Resume.app
```

macOS can also ask to let the app control Claude so it can close and reopen it. Enter a password only in the macOS prompt.

The app is compiled locally and is not notarized. Rebuilding or updating it can invalidate an existing Accessibility grant. If resume stops working after an update, remove the old entry, add the app from the path above, and enable it again.

## Data and account checks

- The local workflow moves Desktop ownership records. It does not copy or rewrite conversation transcripts or sidecar files.
- It checks destination collisions and active workers. A metadata journal supports recovery from an interrupted move. It refuses to recover records that changed after the interruption.
- Scheduled-task settings move with their records; disabled tasks stay disabled. Scheduled runs are not resumed by this button.
- Account verification reads the current Claude Desktop login, including its cookie database and Safe Storage key in macOS Keychain. It makes authenticated requests only to `https://claude.ai` to read account and organization metadata. Successful checks are cached for up to five minutes. No cookie or key is saved in the fork's settings.
- The app stores account labels, record IDs, and move/resume metadata locally in `~/Library/Application Support/claude-transplant-resume/`. Do not upload that folder to a public issue.
- The menubar workflow does not migrate ordinary Claude web chats or Projects, change subscriptions, or reconcile remote-only conversations. It supports a verified Personal Max/Pro destination; Team and Enterprise destinations are blocked.

The original advanced CLI remains in the source. Its `--cloud` mode can read and modify Remote Control state; it is separate from this menubar workflow. Refer to the [upstream 4.1.2 documentation](https://github.com/vitaliyhayda/claude-transplant/tree/v4.1.2), substituting the `claude-transplant-resume` command. Do not mix that workflow with an active collection.

## Update or remove

Install a newer fork release tag with the same `npm install -g` command, then run `claude-transplant-resume menubar` again. An upstream `npm install -g claude-transplant` does not update this fork.

```sh
claude-transplant-resume menubar --remove
npm uninstall -g @miguelpieras/claude-transplant
```

Removal stops the app and removes its login item. It retains local move metadata so removal cannot silently discard recovery state.

## Development and verification

```sh
git clone https://github.com/miguelpieras/claude-transplant.git
cd claude-transplant
npm test
swiftc -parse-as-library -typecheck menubar.swift workflow.swift
npm pack --dry-run
```

There are no runtime npm dependencies. `transplant.js` keeps the upstream engine and account discovery. `local-workflow.mjs` isolates collection selection, local moves, and recovery. `workflow.swift` holds the resume controls and native Accessibility operations. Tests use synthetic records and transcripts.

The local predecessor was tested with live moves and resumed conversations on macOS 15.7.9 and Claude Desktop 2.26454.2. The release checks cover synthetic fresh setup, moves, collisions, rollback, crash recovery, resume selection, packaging, and Swift compilation. Wider macOS and Claude Desktop compatibility is untested. Claude's local file format, log messages, and controls can change.

Report reproducible problems in [Issues](https://github.com/miguelpieras/claude-transplant/issues). Remove account names, conversation contents, and credentials from reports. See [SECURITY.md](SECURITY.md) for sensitive reports.
