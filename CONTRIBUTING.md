# Contributing

This fork adds a local move and resume workflow to upstream Claude Transplant 4.1.2. Keep changes small and retain the MIT attribution.

- Use Node 22 or later. Run `npm test` and `swiftc -parse-as-library -typecheck menubar.swift workflow.swift`.
- Use synthetic fixtures. Never commit local account state, credentials, transcripts, receipts, or personal screenshots.
- Keep the upstream engine in `transplant.js`. Collection/recovery logic and native resume controls are separate modules so they can be tested and packaged together.
- State the macOS and Claude Desktop versions for live behavior claims. Assistant activity is not proof of task completion.
- Do not add an npm publishing or signing workflow without an explicit release decision.
