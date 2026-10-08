# Security

Do not put credentials, account state, or conversation contents in a public issue. Use [private vulnerability reporting](https://github.com/miguelpieras/claude-transplant/security/advisories/new) for security problems.

The menubar verifies account and plan metadata using the current Claude Desktop cookie database and its Safe Storage key from macOS Keychain. Decrypted cookies stay in memory and are sent only to `https://claude.ai`. Account IDs, plan labels, and timestamps are cached locally. Plain `accounts` listing does not fetch credentials; local workflow planning can refresh account metadata.

Local moves keep transcript and sidecar files unchanged. The recovery journal contains record hashes and task metadata, not a transcript backup. Resume sends a continuation message through the native Claude Desktop interface and can start work under the selected Claude plan. Accessibility access is required only for that resume operation.

The inherited advanced `--cloud` CLI is separate. It can read remote history and archive or restore source Remote Control entries. Do not mix it with a collection managed by the menubar.

The app uses undocumented Claude file formats and controls. If account identity or a selected conversation cannot be verified, the operation must stop. The macOS app is compiled locally; rebuilding can require the user to grant Accessibility access again.
