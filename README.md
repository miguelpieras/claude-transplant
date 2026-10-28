# Claude Transplant Resume

Move local Claude Code conversations to a verified Personal plan, then resume interrupted work.

**Unofficial macOS beta.** This is a fork of [Claude Transplant by Vitaliy Hayda](https://github.com/vitaliyhayda/claude-transplant), based on upstream 4.1.2. The original MIT license and copyright remain in [LICENSE](LICENSE).

## Install

Requires macOS 13 or later, Node.js 22.21 or later, Claude Desktop, and the Xcode command line tools (`xcode-select --install`). Project transfer requires macOS 14 or later.

```sh
npm install -g github:miguelpieras/claude-transplant#v4.1.3-resume.18
claude-transplant-resume menubar
```

The app starts at login. Open **Claude Transplant Resume** from the menu bar. The GitHub tag is the release source; this fork is not published to the npm registry.

The fork has its own command, app identity, and settings directory. Quit the original Claude Transplant app before using this fork. Do not run two migration tools at the same time. Finish or cancel any pending move in the original app first.

## Use

1. On first use, open **Accounts** and select **Use these conversations** for the source account and plan. You can select its saved local records after you change accounts.
2. Sign into the destination in **Claude Desktop** and select its **Personal Max or Personal Pro** plan. A terminal Claude Code login does not change the Desktop account.
3. Click **Move and resume**. Claude closes briefly, the app moves the local records, and Claude opens again. Clear **Resume stopped conversations** to move without continuation messages.
4. Read the result and open **Details** for any conversation that needs attention.

The menu bar flow moves local conversations directly. It does not copy or check cloud Projects. It needs no source capture or source login before the move. Old or failed project captures do not block it.

The app shows **Checking account…** while it reads and verifies your Claude login. Move and resume are unavailable during this check. A failed account check is reported separately from a verified plan that is not Personal Max or Pro. After a failed account check, click Refresh to check the current login again.

The collection follows its last destination. New conversations created there join the next move. Conversations that were already in a destination before the move stay there if you later move the collection away. **Accounts → Choose a different source** explicitly starts a new collection from all records in that account and plan.

For the next move, sign into the next Personal plan and click **Move and resume**. On the current plan, **Resume stopped conversations** can continue recent unfinished work without a move. The inherited CLI `undo` command uses different receipts and is disabled once a collection has been selected.

### Resume behavior

The app considers unfinished conversations active in the last 24 hours. It excludes archived conversations, scheduled runs, and conversations that already report a request for user input. It sends this message through Claude Desktop:

> Continue the existing task from where it stopped. Check the result of any interrupted command or pending check before running it again. Keep the existing scope and instructions.

After your allowance resets, use **Resume limit-stopped** on the current plan. The count shows recent conversations with a session, weekly, usage, or rate-limit error. This button sends the same Continue message without moving records or changing accounts. It uses the same 24-hour window and exclusions; other errors and finished work are not selected. It does not check when your allowance resets, so Claude can report the limit again if it is still active.

Running conversations and unsent drafts are left alone. The app opens each conversation by its session ID, so conversations with the same title are resumed separately. It checks the selected account and conversation ID before sending. English Claude Desktop controls are required for this beta.

The result confirms new assistant activity or a visible running state. It does **not** prove that the conversation's task has finished. A resumed conversation can still reach a usage limit, request approval, or need other input. Continuation requests use the selected Claude plan's allowance.

## macOS permissions

Automatic resume needs **System Settings → Privacy & Security → Accessibility → Claude Transplant Resume**. The app requests access before a resume operation. Move-only operation does not need Accessibility access.

If the app is absent from the list, click **Open app folder** in its permission message, then add the app with the `+` button in System Settings. Its installed location is:

```text
~/Library/Application Support/claude-transplant-resume/Claude Transplant Resume.app
```

macOS can also ask to let the app control Claude so it can close and reopen it. Enter a password only in the macOS prompt.

The app is compiled locally and is not notarized. Updates that change only JavaScript or the version keep the native app binary and its Accessibility grant. Rebuilding the native app can invalidate that grant. If resume stops working after a native update, remove the old entry, add the app from the path above, and enable it again.

## Data and account checks

- The move changes Desktop record ownership. Transcripts and sidecar files stay at their shared local paths. It does not need a full history copy.
- It checks destination collisions and active workers. A metadata journal supports recovery from an interrupted move. It refuses to recover records that changed after the interruption.
- Scheduled-task settings move with their records; disabled tasks stay disabled. Scheduled runs are not resumed by this button.
- Account verification reads the current Claude Desktop login, including its cookie database and Safe Storage key in macOS Keychain. It makes authenticated requests only to `https://claude.ai` to read account and organization metadata. Successful checks are cached for up to five minutes. No cookie or key is saved in the fork's settings.
- The app stores account labels, record IDs, and move/resume metadata locally in `~/Library/Application Support/claude-transplant-resume/`. Old project captures can also be in this folder. Do not upload it to a public issue.
- The local conversation workflow does not move ordinary Claude web chats, remote-only conversations, or cloud Projects. A destination must be a verified Personal Max/Pro plan; Team and Enterprise destinations are blocked.

The original advanced CLI remains in the source. Its `--cloud` mode can read and modify Remote Control state; it is separate from this menubar workflow. Refer to the [upstream 4.1.2 documentation](https://github.com/vitaliyhayda/claude-transplant/tree/v4.1.2), substituting the `claude-transplant-resume` command. Do not mix that workflow with an active collection.

## Update or remove

Install a newer fork release tag with the same `npm install -g` command, then run `claude-transplant-resume menubar` again. An upstream `npm install -g claude-transplant` does not update this fork.

```sh
claude-transplant-resume menubar --remove
npm uninstall -g @miguelpieras/claude-transplant
```

Removal stops the app and removes its login item. It retains local move metadata so removal cannot silently discard recovery state.

## Advanced project commands

Project transfer is separate from the menu bar flow. These CLI commands remain available for an explicit project transfer. They require project write access on the destination and macOS 14 or later.

```sh
# Keep the source signed into Claude Desktop.
claude-transplant-resume project-stage-all
# Wait for Ready to switch accounts, then change the Desktop login.
claude-transplant-resume project-move
```

`project-stage-all` pauses the source projects and saves their state and local conversations. `project-move` rebuilds the projects from that saved state. It checks destination access before it writes project data. `project-move --no-resume` leaves the new projects paused. `project-select` and `project-stage` select and capture one project.

A project transfer creates new projects. It does not change source project ownership or import native thread history. Thread histories become reference files. Sources stay paused after capture. Continuation requests do not prove that work started or finished. These commands do not move the local conversation records; use the menu bar flow for that step.

### Saved captures

The read-only capture commands remain available for an explicit fixed capture. They do not pause the source, create a destination, or start work.

While signed into the source account in Claude Desktop, run:

```sh
claude-transplant-resume project-capture \
  --project chan_PROJECT_ID \
  --source ACCOUNT_UUID/ORGANIZATION_UUID \
  --output /absolute/existing/private-parent/project-capture

claude-transplant-resume project-verify \
  --capture /absolute/existing/private-parent/project-capture

claude-transplant-resume project-prepare \
  --capture /absolute/existing/private-parent/project-capture \
  --output /absolute/existing/private-parent/project-rebuild
```

Use a new output folder for each capture or preparation. Its parent must exist. The tool creates private directories and files and refuses symlink paths. Capture folders contain private conversation data. Keep them outside the repository and do not upload them to an issue.

Capture reads the project settings, main conversation, thread list, each thread's messages and bound session history, shared memory, library files, attachments, and linked local transcripts. It matches local records by session ID, not title. It checks pagination, file hashes, and source changes. A failed read or a changing source produces an explicit incomplete capture. That capture is retained, but preparation refuses it. Repeat the capture into a new folder after the source is stable.

Native report documents need a separate content export. Their viewer code does not contain the document text. Pass `--artifact-exports /absolute/private-folder` to use current text exports. That folder must be private and contain `<artifact-UUID>.txt` files and an `artifacts.json` file:

```json
{
  "schemaVersion": 1,
  "projectId": "chan_PROJECT_ID",
  "artifacts": [{
    "id": "ARTIFACT_UUID",
    "file": "ARTIFACT_UUID.txt",
    "format": "text",
    "updatedAt": "2026-10-22T10:00:00Z",
    "sha256": "SHA256_OF_TEXT_FILE"
  }]
}
```

The capture checks the export's file hash and source update time. It reports text exports as text and links, with native layout and widget state excluded. Missing or stale exports keep the capture incomplete. It never saves viewer access tokens.

Preparation verifies every saved file and writes `restore-plan.json`, `RESTORE.md`, a main transcript, and a handoff for each thread. Original captured bytes remain available. The plan includes portable settings and file upload mappings, requires a paused destination, and permits no overwrites or automatic thread starts. Account-specific connections, environments, permissions, and device access require separate setup.

Project transfer rebuilds the project; it does not import native thread history. The prepared files preserve the main conversation and each thread as reference files for new work. Account-specific connections and device permissions require setup in the destination. Native report layout and widget state are not included in text exports. These commands use private Claude interfaces, which can change.

## Development and verification

```sh
git clone https://github.com/miguelpieras/claude-transplant.git
cd claude-transplant
npm test
swiftc -parse-as-library -typecheck menubar.swift workflow.swift project-artifact-export.swift
npm pack --dry-run
```

There are no runtime npm dependencies. `transplant.js` keeps the upstream engine and account discovery. `local-workflow.mjs` isolates local moves and recovery. The project modules read and verify current source data, restore it, and send one continuation request. `local-capture.mjs` supports saved captures for the advanced project commands. `workflow.swift` holds the native controls and Accessibility operations. Tests use synthetic records and transcripts.

The local predecessor was tested with live moves and resumed conversations on macOS 15.7.9 and Claude Desktop 2.26454.2. The release checks cover synthetic fresh setup, moves, collisions, rollback, crash recovery, resume selection, packaging, and Swift compilation. Wider macOS and Claude Desktop compatibility is untested. Claude's local file format, log messages, and controls can change.

Report reproducible problems in [Issues](https://github.com/miguelpieras/claude-transplant/issues). Remove account names, conversation contents, and credentials from reports. See [SECURITY.md](SECURITY.md) for sensitive reports.
