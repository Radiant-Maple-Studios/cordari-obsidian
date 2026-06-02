# RoveNotes for Obsidian

Sync your [RoveNotes](https://app.rovenotes.com) voice recordings and
handwritten notes into your Obsidian vault as markdown files — one page
per recording (audio embedded inline, summary, full transcript) and one
page per handwritten note (recognized markdown + summaries).

## What it does

Each sync pass:

- Creates `RoveNotes/{date}_{filename}__{shortId}.md` per recording, with YAML
  frontmatter (`rovenotes_id`, `rovenotes_url`, `date`, `duration_ms`, `filename`,
  `state`).
- Saves the recording's audio next to the markdown as `.ogg` so it plays in
  Reading Mode via `![[...ogg]]`.
- Creates `RoveNotes/Notes/{date}_{filename}__{shortId}.md` per handwritten
  note (Boox today), with the recognized markdown, any AI summaries, and a
  link back to the note in RoveNotes. No audio — handwriting only.
- Reconciles continuously — renames on the RoveNotes side propagate to the
  file, late-arriving transcripts/summaries/recognition update the same
  file in place, and anything you deleted from the vault gets rewritten
  on the next sync.

The plugin only sends read requests; nothing in your vault is pushed back
to RoveNotes.

## Requirements

- A RoveNotes Pro account (free tier doesn't grant API access).
- Obsidian 1.4.0+ on desktop (macOS / Windows / Linux). Mobile isn't
  supported yet — the plugin declares `isDesktopOnly: true`.

## Install

1. Obsidian → Settings → Community plugins → Browse.
2. Search for **RoveNotes**, install, enable.
3. Open the plugin's settings and click **Connect to RoveNotes**.

### Local build (for development)

1. Build: `npm install && npm run build` from the repo root.
2. Copy `dist/main.js`, `manifest.json`, and `styles.css` into
   `<your-vault>/.obsidian/plugins/rovenotes-notes/`.
3. Obsidian → Settings → Community plugins → turn off Restricted mode,
   refresh the installed plugins list, enable **RoveNotes**.

## Linking the plugin to your account

1. Open Settings → **RoveNotes** → **Connect to RoveNotes**.
2. The plugin shows an 8-character code + a link to `app.rovenotes.com/link`.
3. Open the link in your browser (already signed in as your RoveNotes user),
   paste the code, approve. Obsidian picks up the approval within a few
   seconds.

You can flip the integration off without disconnecting from Settings →
Integrations → Obsidian on the web. Revoking the token fully ("Revoke all")
requires re-linking next time.

## Settings

- **Vault folder** — where recording files live. Default `RoveNotes`.
- **Auto-sync interval** — minutes between polls. Minimum 1, default 5.
- **Sync now** — runs the loop immediately (also available as a ribbon
  icon and command palette entry).

## Support

File issues at
[github.com/Radiant-Maple-Studios/rovenotes-obsidian](https://github.com/Radiant-Maple-Studios/rovenotes-obsidian/issues)
or reach out via [app.rovenotes.com](https://app.rovenotes.com).

## License

MIT.
