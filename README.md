# Claude Transplant Resume

Move Claude Code projects and local conversations to a verified Personal plan, then resume interrupted work.

**Unofficial macOS beta.** This is a fork of [Claude Transplant by Vitaliy Hayda](https://github.com/vitaliyhayda/claude-transplant), based on upstream 4.1.2. The original MIT license and copyright remain in [LICENSE](LICENSE).

## Install

Requires macOS 13 or later, Node.js 22.21 or later, Claude Desktop, and the Xcode command line tools (`xcode-select --install`). Project transfer requires macOS 14 or later.

```sh
npm install -g github:miguelpieras/claude-transplant#v4.1.3-resume.10
claude-transplant-resume menubar
```

The app starts at login. Open **Claude Transplant Resume** from the menu bar. The GitHub tag is the release source; this fork is not published to the npm registry.

The fork has its own command, app identity, and settings directory. Quit the original Claude Transplant app before using this fork. Do not run two migration tools at the same time. Finish or cancel any pending move in the original app first.

## Use

1. While signed into the source account in **Claude Desktop**, click **Transplant**. On first use, select **Use these conversations** in Accounts. This selects all local conversation records in that account and plan. All its Code Projects join the same move.
2. Wait for **Ready to switch accounts**. The app pauses the source projects, saves their cloud data and the local conversations on this Mac, and checks the saved files. Keep the source signed in until this step is complete.
3. Sign out of Claude Desktop. Sign into the destination and select its **Personal Max or Personal Pro** plan. A terminal Claude Code login does not change the Desktop account.
4. Click **Move and resume**. The app restores the saved projects and moves the local conversation records. Claude closes briefly for the local move and opens again. Clear **Resume stopped conversations** to move without continuation messages.
5. Read the result and open **Details** for any conversation that needs attention.

The app shows **Checking account…** while it reads and verifies your Claude login. Move and resume are unavailable during this check. A failed account check is reported separately from a verified plan that is not Personal Max or Pro.

The collection follows its last destination. New conversations created there join the next move. Conversations that were already in a destination before the move stay there if you later move the collection away. **Accounts → Choose a different source** explicitly starts a new collection from all records in that account and plan.

For the next move, click **Transplant** on the current account before you sign out. Then sign into the next Personal plan and click **Move and resume**. The inherited CLI `undo` command uses different receipts and is disabled once a collection has been selected.

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

- Preparation saves local ownership records, matching transcripts, sidecar files, scheduled settings, and collection settings in a private capture. The move changes Desktop record ownership; transcripts and sidecar files stay at their shared local paths.
- It checks destination collisions and active workers. A metadata journal supports recovery from an interrupted move. It refuses to recover records that changed after the interruption.
- Scheduled-task settings move with their records; disabled tasks stay disabled. Scheduled runs are not resumed by this button.
- Account verification reads the current Claude Desktop login, including its cookie database and Safe Storage key in macOS Keychain. It makes authenticated requests only to `https://claude.ai` to read account and organization metadata. Successful checks are cached for up to five minutes. No cookie or key is saved in the fork's settings.
- The app stores private project captures, local conversation captures, account labels, record IDs, and move/resume metadata locally in `~/Library/Application Support/claude-transplant-resume/`. Do not upload that folder to a public issue.
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

All Code Projects from the conversation source join the **Transplant** action. The main panel shows the conversation and project counts. The app reads the full source project list when you click, so it includes projects made after the last status check.

When your allowance runs out, keep the source account signed into Claude Desktop and click **Transplant**. The app pauses each source project, requires idle workers, and saves its settings, memory, thread history, files, and native report state. It also saves the local conversations. It checks source consistency and the saved files before it shows **Ready to switch accounts**. Missing content, running workers, or source changes stop preparation. Keep the source signed in and retry if preparation fails.

You can then sign out and sign into the next Personal plan. **Move and resume** checks the saved files and the destination account. It uses the saved source data without a source login or a source cloud request. Changes made after preparation are not part of that copy. To include later work, click **Transplant** again before you sign out.

The transfer creates a new private project, uploads the saved files and memory, and reads them back for verification. Native thread history cannot be imported: each thread and the main conversation are kept as reference files, indexed from project memory. With resume enabled, the app unpauses the new project and sends one coordinator request to continue unfinished work from those files. Acceptance of this request does not prove that a worker started or that its task finished. Clear **Resume stopped conversations** for a paused transfer with no continuation request.

The project collection follows its new destination. New projects made there join the next move. Projects that were already in that destination stay there, as with local conversations. The app does not keep a separate source login.

An interrupted move uses the same saved copy and destination projects. A continuation retry uses the same saved message ID. Empty, archived, and paused projects are copied without starting work. Sources remain paused after preparation and transfer.

The same flow is available in the CLI:

```sh
# Keep the source signed into Claude Desktop.
claude-transplant-resume project-stage-all
# Wait for Ready to switch accounts, then change the Desktop login.
claude-transplant-resume project-move
# The menu bar action also moves and resumes local conversations.
```

`project-status --json` shows preparation status and counts. `project-move --no-resume` leaves the new projects paused. `project-select` and `project-stage` remain advanced commands for a single project. Source and destination projects remain available. A transfer rebuilds the saved state in new projects; it does not change ownership of the source projects.

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

There are no runtime npm dependencies. `transplant.js` keeps the upstream engine and account discovery. `local-workflow.mjs` isolates local moves and recovery. The project modules read and verify current source data, restore it, and send one continuation request. `local-capture.mjs` saves and checks local conversation files before sign-out. `workflow.swift` holds the native controls and Accessibility operations. Tests use synthetic records and transcripts.

The local predecessor was tested with live moves and resumed conversations on macOS 15.7.9 and Claude Desktop 2.26454.2. The release checks cover synthetic fresh setup, moves, collisions, rollback, crash recovery, resume selection, packaging, and Swift compilation. Wider macOS and Claude Desktop compatibility is untested. Claude's local file format, log messages, and controls can change.

Report reproducible problems in [Issues](https://github.com/miguelpieras/claude-transplant/issues). Remove account names, conversation contents, and credentials from reports. See [SECURITY.md](SECURITY.md) for sensitive reports.
