# App updates

- Use `node transplant.js menubar` to install a local update. Do not copy files into the installed signed app.
- Keep the bundle identifier and saved signing identity. Do not use local signing when the saved identity is unavailable.
- Write all app files before signing. Verify the complete staged app before replacing the installed app. Keep the previous app until the new app starts.
- Run `npm test` and the Swift type check before delivery. Check the installed signature after an update.
- Check Accessibility access before automatic resume. Use the normal macOS settings if approval is needed. Do not edit the privacy database or reset permissions for other apps.
