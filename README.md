# QuickNotes

A small installable web app (PWA) for quick notes and to-do lists. It syncs between computers and phones through one file in Google Drive.

- Plain notes and checklists. You can turn a note into a checklist and back.
- Each note can have its own background color, and you can pin notes to the top.
- Tap the box next to a checklist item on the note card to check it off without opening the note.
- If you paste several lines into a checklist item, each line becomes its own item. `- [ ]`, `- [x]`, `☐` and `☑` markers are recognised.
- Checked items are tucked under a collapsed "checked items" group. **Delete checked** there removes them all at once.
- Deleted notes and lists go to the Trash (the bin icon at the top), where you can restore them. Anything in the Trash is deleted for good after 7 days.
- The copy button puts the whole note on the clipboard.
- Works offline. Notes are kept on the device and saved to Drive the next time you're online and signed in.
- Plain HTML/CSS/JS with no build step and no libraries.

## How syncing works

All notes are stored in a single file, `QuickNotes.json`, in the root of My Drive. The app creates the file the first time you sign in.

- There is no Sync button. Edits are saved to Drive about 1.5 seconds after you stop typing.
- While the app is open, it checks Drive for changes every 15 seconds and whenever you switch back to it. If the file hasn't changed, the check costs one small request.
- Each sync downloads the file, merges it with the notes on the device, and uploads the result only if something changed. If the same note was edited on two devices, the most recent edit wins. Changes to different notes never overwrite each other.
- Trash is synced too, so a note moved to the Trash on one device is in the Trash on all of them.
- When a note is deleted for good, a marker is kept in the file for 30 days so that the delete also reaches your other devices.

## Google permissions

The app asks for one Drive scope, `drive.file`. With it, the app can see and edit only the files it created itself, which is just `QuickNotes.json`. It can't read anything else in your Drive.

Because of `drive.file`, the app can't use a `QuickNotes.json` that you make by hand or upload. If you delete the file in Drive, the app makes a new one from the notes on the device on its next sync.

## Setup

This app reuses the Google Cloud OAuth client from Rove Recipes. `config.js` already contains that client ID. It works because both apps are served from the same origin (`https://mhenry1384.github.io` and `http://localhost:8080`), and that project already has the Drive API and the `drive.file` scope set up.

The Google sign-in screen will show the app name from that project's consent screen, "Rove Recipes". To change it, go to **Google Auth Platform → Branding** in the Cloud console and rename it, for example to "Rove apps".

**Redirect URIs (required):** sign-in uses Google's redirect flow rather than a popup, so in the Cloud console go to **Google Auth Platform → Clients →** (the Rove Recipes web client) **→ Authorized redirect URIs** and add both of these, exactly as written, including the trailing slash:

- `https://mhenry1384.github.io/Rove-QuickNotes/`
- `http://localhost:8080/`

Adding them doesn't affect Rove Recipes.

To use a separate Google Cloud project instead, follow the "Google Cloud OAuth client" steps in the Rove Recipes README with only the `.../auth/drive.file` scope, then put the new client ID in `config.js`.

### Hosting

The app is hosted on GitHub Pages at <https://mhenry1384.github.io/Rove-QuickNotes/>, from the `main` branch of <https://github.com/mhenry1384/Rove-QuickNotes> (Settings → Pages → Deploy from a branch → `main` / `/ (root)`). Pushing to `main` publishes the new version within a minute or two.

### Running locally

```
npx serve -l 8080 .
```
or `python -m http.server 8080`, then open <http://localhost:8080>.

## Installing the app

- **Windows / Mac (Chrome or Edge):** click the install icon in the address bar, or use the menu → *Install QuickNotes*.
- **Mac (Safari 17+):** File → *Add to Dock*.
- **Android (Chrome):** menu → *Add to Home screen* / *Install app*.
- **iPhone (Safari):** Share → *Add to Home Screen*.

## Keyboard shortcuts

- `N`: new note
- `L`: new checklist
- `/`: search
- `Esc`: close the open note

## Notes

- Google sign-in tokens last about an hour. To get a new one, the app briefly visits Google, which sends it straight back without asking anything as long as you're still signed in to Google. You may see the page blink. This only happens when nothing is in the way: when you open or switch back to the app, when you close a note, or after 20 seconds of not touching the app. It never happens while a note is open. Edits made in the meantime are kept on the device and saved right after.
- The Sign in button appears only if Google needs you to confirm something, for example after you sign out of Google.
- **Releasing updates:** increase `APP_VERSION` in `version.js` on every push. The number appears next to the app name, and it also names the service-worker cache, so installed copies drop their old files.
