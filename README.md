# Claude Transplant Resume

Move local Claude Desktop Code conversations to a verified Personal plan, then resume interrupted work.

**Unofficial macOS beta.** This is a fork of [Claude Transplant by Vitaliy Hayda](https://github.com/vitaliyhayda/claude-transplant), based on upstream 4.1.2. The original MIT license and copyright remain in [LICENSE](LICENSE).

## Install

Requires macOS 13 or later, Node.js 22.21 or later, Claude Desktop, and the Xcode command line tools (`xcode-select --install`). Project transfer requires macOS 14 or later.

```sh
npm install -g github:miguelpieras/claude-transplant#v4.1.3-resume.8
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

The app shows **Checking account…** while it reads and verifies your Claude login. Move and resume are unavailable during this check. A failed account check is reported separately from a verified plan that is not Personal Max or Pro.

The collection follows its last destination. New conversations created there join the next move. Conversations that were already in a destination before the move stay there if you later move the collection away. **Accounts → Choose a different source** explicitly starts a new collection from all records in that account and plan.

To move back, sign into the previous Personal plan and use the same button. The inherited CLI `undo` command uses different receipts and is disabled once a collection has been selected.

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

The app is compiled locally and is not notarized. Rebuilding or updating it can invalidate an existing Accessibility grant. If resume stops working after an update, remove the old entry, add the app from the path above, and enable it again.

## Data and account checks

- The local workflow moves Desktop ownership records. It does not copy or rewrite conversation transcripts or sidecar files.
- It checks destination collisions and active workers. A metadata journal supports recovery from an interrupted move. It refuses to recover records that changed after the interruption.
- Scheduled-task settings move with their records; disabled tasks stay disabled. Scheduled runs are not resumed by this button.
- Account verification reads the current Claude Desktop login, including its cookie database and Safe Storage key in macOS Keychain. It makes authenticated requests only to `https://claude.ai` to read account and organization metadata. Successful checks are cached for up to five minutes. No cookie or key is saved in the fork's settings.
- The app stores account labels, record IDs, and move/resume metadata locally in `~/Library/Application Support/claude-transplant-resume/`. Do not upload that folder to a public issue.
- The local conversation workflow does not move ordinary Claude web chats or remote-only conversations. Selected Code Projects move through the same button, as described below. A destination must be a verified Personal Max/Pro plan; Team and Enterprise destinations are blocked.

The original advanced CLI remains in the source. Its `--cloud` mode can read and modify Remote Control state; it is separate from this menubar workflow. Refer to the [upstream 4.1.2 documentation](https://github.com/vitaliyhayda/claude-transplant/tree/v4.1.2), substituting the `claude-transplant-resume` command. Do not mix that workflow with an active collection.

## Update or remove

Install a newer fork release tag with the same `npm install -g` command, then run `claude-transplant-resume menubar` again. An upstream `npm install -g claude-transplant` does not update this fork.

```sh
claude-transplant-resume menubar --remove
npm uninstall -g @miguelpieras/claude-transplant
```

Removal stops the app and removes its login item. It retains local move metadata so removal cannot silently discard recovery state.

## Transfer a Code Project in its latest state

Select the project in the menu bar while signed into its source account. Use **Connect source** once to sign into that account in Transplant's separate login window. This keeps source access separate from the Claude Desktop login. No source preparation or Desktop account switch back is required.

When your allowance runs out, sign into the next Personal plan in Claude Desktop and click **Move and resume**. On that click, Transplant checks the destination, pauses the source project, waits for idle workers, and reads its current settings, memory, thread history, files, and native report state. It checks the source again before it creates the destination. Missing content, running workers, or source changes stop the transfer. An older capture is never substituted.

The transfer creates a new private project, uploads the current files and memory, and reads them back for verification. Native thread history cannot be imported: each thread and the main conversation are kept as reference files, indexed from project memory. With resume enabled, the app unpauses the new project and sends one coordinator request to continue unfinished work from those files. Acceptance of this request does not prove that a worker started or that its task finished. Clear **Resume stopped conversations** for a paused transfer with no continuation request.

The project selection follows its new destination. Each source account needs its own **Connect source** login once. A saved connection can be used again while it remains valid. If it expires, reconnect it in Transplant; Desktop can stay on the destination. The source login is held in a separate macOS WebKit store for that account. The app stores only public connection metadata in its settings and uses source cookies in memory for requests.

An interrupted restore uses the same new project after a live source check. A continuation retry uses the same saved message ID. The source remains paused after a successful transfer.

The same flow is available in the CLI:

```sh
claude-transplant-resume project-select \
  --project chan_PROJECT_ID --source ACCOUNT_UUID/ORGANIZATION_UUID
claude-transplant-resume project-connect
# Switch accounts in Claude Desktop.
claude-transplant-resume project-move
```

`project-status --json` shows the selection and source connection. `project-move --no-resume` leaves the new project paused. `project-stage` remains an advanced manual capture command. Source and destination projects remain available. A transfer rebuilds the current state in a new project; it does not change ownership of the source project.

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

There are no runtime npm dependencies. `transplant.js` keeps the upstream engine and account discovery. `local-workflow.mjs` isolates local moves and recovery. The project modules read and verify current source data, restore it, and send one continuation request. `source-web.swift` keeps source logins separate from Desktop. `workflow.swift` holds the native controls and Accessibility operations. Tests use synthetic records and transcripts.

The local predecessor was tested with live moves and resumed conversations on macOS 15.7.9 and Claude Desktop 2.26454.2. The release checks cover synthetic fresh setup, moves, collisions, rollback, crash recovery, resume selection, packaging, and Swift compilation. Wider macOS and Claude Desktop compatibility is untested. Claude's local file format, log messages, and controls can change.

Report reproducible problems in [Issues](https://github.com/miguelpieras/claude-transplant/issues). Remove account names, conversation contents, and credentials from reports. See [SECURITY.md](SECURITY.md) for sensitive reports.
