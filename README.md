# Quip → Markdown exporter

A Chrome (Manifest V3) extension that copies your Quip folders and documents into a folder on your computer as Markdown, keeping Quip's folder structure. It also converts embedded content that other exporters drop: **calendars, Kanban boards, project trackers, process bars, embedded and standalone spreadsheets**, comments, images and file attachments.

**It is read-only.** It cannot create, edit or delete anything in Quip, and it never deletes files from your target folder or overwrites a file it did not create. See [Read-only guarantees](#read-only-guarantees).

Quip is being retired. [Salesforce's notice](https://help.salesforce.com/s/articleView?id=005299603&language=en_US&type=1) says subscriptions cannot be renewed after 1 March 2027 and gives 31 March 2027 as the date after which an instance is no longer accessible; your own deadline is whichever applies to your account. Export while you can still sign in.

## Quick start

```bash
npm ci
npm run build          # writes the extension to dist/
```

1. In Chrome or Edge open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, choose **Load unpacked** and pick the `dist/` folder. (The exporter uses an API token, not your browser session, so it works in any Chromium browser. Loading unpacked extensions in Dia is untested.)
2. While signed in to Quip, open `https://<your-site>.quip.com/dev/token` (or `quip.com/dev/token`) and copy a personal access token. Generating a new token invalidates the previous one, [according to ClonePartner's guide](https://clonepartner.com/blog/how-to-export-data-from-quip-methods-api-limits-migration-prep).
3. Click the extension's toolbar icon. If a Quip page is open when you click, you can export just that document or folder.
4. Paste the token, **Connect**, **Choose folder…**, then **Scan** (nothing is written yet) and **Start export**.

For a first run, tick *Limit to the first N documents* and try 5. Keep the tab open while it runs; you can stop at any time and continue later, and finished documents are not downloaded again.

## What you get

```text
<target folder>/
  Private/                      Quip folder tree, one directory per folder (empty folders too)
    Projects/Project Plan.md    one note per document
    Projects/Budget.md          a note with a spreadsheet gets the original next to it…
    Projects/Budget.xlsx        …as .xlsx, the only way to keep formulas (optional)
  Team Shared/…
  _Unfiled/                     documents you wrote that are in no folder of your account
  _attachments/<thread id>/…    images and files, linked with relative paths
  .quip-raw/<thread id>/        Quip's original HTML, metadata and messages (optional)
  .quip-md-export/              resume state and a machine-readable report
  _Quip export report.md        what was exported, and what needs attention
```

Each note starts with YAML front matter and uses relative Markdown links, so it opens cleanly in Obsidian or any editor:

- `title`, `quip_id`, `quip_url`, `quip_type`, `created`, `updated`, `author`, `exported`, `exporter`
- `folder`, plus `also_in` for other folders that contain the same document. Quip folders behave like tags, so a document in several folders is written once, under the first folder in the order you export them.
- `embeds`: the kinds of embedded content found (`calendar`, `kanban`, `project_tracker`, `spreadsheet`, …)
- `moved_to`: set when Quip says the document was already moved elsewhere (for example to Slack)

Links between exported documents are rewritten to relative links. Links to documents outside the export keep their Quip URL and are listed in the report, since they stop working when Quip does.

**Running it again** is safe and incremental:

- A file this tool wrote is updated in place when the document changed in Quip, when a note it links to appeared, moved or was renamed (so its relative links stay right), or when you changed the options that affect its content. **Edits you make to a generated note are lost when it is rewritten**, so keep your own writing in separate notes.
- A file this tool did *not* write is never touched: the note gets a numbered name instead, such as `Notes (2).md`. The names `_attachments`, `_Unfiled` and `_Quip export report.md` are reserved.
- A document renamed or moved in Quip gets a new file; the old copy stays where it was (nothing is deleted) and is listed in the report.
- "Unfiled" means documents you wrote that are in no folder anywhere in your account. Documents other people wrote that are in none of your folders are counted in the scan but not exported.

## What is converted

- Headings, paragraphs, bold/italic/strikethrough/underline, code blocks, quotes, rules, links, images, file attachments
- Bullet, numbered (with continued numbering) and check lists, nested to any depth
- Tables and spreadsheets (merged cells expanded, Quip's column letters and row numbers removed, one table per sheet). Quip's HTML carries only the displayed values, so the note also links a `.xlsx` export of the same spreadsheet with its formulas (untick *Also save spreadsheets as .xlsx* to skip it)
- **Calendar**: a Date/Event table sorted by date, with ranges and colours
- **Kanban board**: columns as a nested list
- **Project tracker**: a table with people, status labels and dates resolved to readable values
- **Process bar**: the step sequence with the current step marked
- Comments and conversation, with authors, timestamps, mentions and attachments, appended to the note
- Slide decks: a stub note plus a PDF copy (Quip offers no other slide export)
- Any other live app: Quip's own table rendering if present, otherwise the raw payload as JSON, plus a `unknown-live-app` warning naming the app so a converter can be added

Not exported: chats, and live Salesforce data (a placeholder with the record ids is written). Comments are listed at the end of the note rather than anchored inline.

## Read-only guarantees

1. **The client can only read.** Every request is a `GET` without a body, sent only to an allow-list of read endpoints; identifiers are validated so they cannot smuggle in another path (`src/core/quipClient.ts`).
2. **The browser enforces it too.** The extension registers a `declarativeNetRequest` rule that blocks every `POST`, `PUT`, `PATCH`, `DELETE` and other non-read request that the extension itself sends to *any* address, so even a future bug could not modify a document. The page shows "Browser-level read-only guard: on".
3. **The pages cannot be steered by document content.** The extension pages run under a strict Content Security Policy: scripts, styles and images only from the extension itself, no frames, no forms, and network access only to `https://platform.quip.com`. Quip HTML is parsed into an inert document and only its text and attributes are read; it is never inserted into the page.
4. **Tests prove it.** The mock Quip server records every request and the tests require zero non-GET requests. The real-browser tests show that writes (`POST`, `PUT`, `PATCH`, `DELETE`) are blocked before they leave the browser, even to an address the extension has no permission for, and that documents full of images, frames, scripts, stylesheets and other tags that normally make a browser fetch something cause no request at all. Static checks forbid any other HTTP method, body, `XMLHttpRequest`, WebSocket or file deletion in shipped code, and `npm run verify-build` checks the bundle for test hooks, `eval` and unexpected hosts, and the manifest for extra permissions and a weakened policy.

Permissions requested: `storage` (settings), `activeTab` (to offer the page you were viewing), `declarativeNetRequest` (the guard) and access to `https://platform.quip.com/*` only. No content scripts, no analytics, nothing is sent anywhere except to Quip. [Chrome describes](https://developer.chrome.com/docs/extensions/reference/permissions-list) `declarativeNetRequest` to the user as "Block content on any page"; the extension uses it only to block its own write requests. The narrower `declarativeNetRequestWithHostAccess` was tried first, but it only covers hosts the extension has permission for, so it could not make the "any address" promise.

## Rate limits and time

Quip's [Automation API](https://quip.com/dev/automation/documentation/current#section/Rate-Limits) allows 50 requests a minute and 750 an hour per user. The exporter paces itself under the per-minute limit and, when Quip answers 503, waits until the limit resets. A document needs about 2 requests (content and comments), plus one per attachment. The first 750 requests run at full speed, so 300 documents take roughly 15 minutes; after that the hourly limit dominates, so 1,000 documents take about 2 hours. **Scan** shows an estimate for your account. Unchanged documents are skipped on later runs.

## Token handling

The token is kept in browser session storage and disappears when the browser closes. Tick *Remember* to also keep it in the extension's local storage (unencrypted, inside your browser profile); unticking it removes the stored copy immediately. If Quip rejects the token during an export, the export stops, nothing further is attempted, and the report says how many documents were left. When you are done, generate a new token at `/dev/token`, which invalidates the old one.

## Known limits

- **Not yet run against a real Quip account.** It was built and tested against a synthetic account that follows Quip's published API specification, plus public Quip HTML samples. Quip's undocumented HTML details (especially for live apps) may differ; the original HTML is kept in `.quip-raw/` so conversion can be improved and re-run without Quip. Start with a small trial.
- Quip's API is [licensed per plan](https://quip.com/dev/automation/documentation/current#section/License-Requirements). If your account cannot create a token, this tool cannot read it.
- A document can be reached through several Quip addresses. Links are matched by the document id, its current share address and the address Quip reports as its link; a link that uses any other one (for example a previous, replaced share address) stays a Quip URL and is listed in the report.
- If Quip ever serves an attachment from a host other than `platform.quip.com` (its API documents a direct response), the page's policy blocks the download and the attachment is listed as failed in the report. Widen `connect-src` in `extension/manifest.json` if that happens.
- Project tracker dates are stored by Quip as timestamps and are shown as the calendar day in your browser's time zone; an author in a very different time zone may see a date one day off.
- Quip's `updated_usec` decides whether a document changed; documents whose live-app content changes without bumping it are not re-exported unless you untick *Skip unchanged*.
- Browsers throttle timers in background tabs; waiting out a rate limit may be a little late but is never early.

## Prior art

None of these is a browser extension that mirrors a whole Quip folder tree as Markdown:

- [Minibase Web Clipper](https://chromewebstore.google.com/detail/minibase-web-clipper/mamnlljnkigkhppbjhmpdeocobcbobdp) is a Chrome extension but converts one page at a time (free tier of 3 saves a month, closed source). Its [Quip guide](https://www.minibase.md/blog/quip-export-to-markdown-guide/) says live apps are rendered only as links.
- [sonnenkern/quip-export](https://github.com/sonnenkern/quip-export) (MIT, archived August 2026) exports the whole account through the API as HTML or DOCX.
- [jmoraispk/quip-export](https://github.com/jmoraispk/quip-export) drives the Quip UI with Playwright to produce HTML, then converts with Pandoc.
- [swestwood/quiport-import](https://github.com/swestwood/quiport-import) builds a browsable HTML archive and documents how Quip's HTML represents live apps (`data-live-app-payload` and a server-rendered `<details>` table), which informed this converter. No code was copied from any of these projects.

## Development

```bash
npm test          # unit and mock-server integration tests
npm run e2e       # builds a test variant and drives it in a real Chromium with Playwright
npm run check     # typecheck, tests, production build, build verification
```

- `src/core/` has no browser dependencies: `convert/` (HTML → Markdown), `quipClient.ts`, `exporter.ts`, `naming.ts`, `rewrite.ts`.
- `src/ui/` is the exporter page (File System Access API, settings, progress); `src/background.ts` opens it.
- `tests/mock/` is a synthetic Quip API (users, folders, paginated HTML, messages, blobs, 503 throttling, failure injection) used by both the integration and browser tests, which require the browser export to match the Node export file for file.

To add support for another embedded type, extend `src/core/convert/liveApps.ts` and add a case to `tests/unit/liveApps.test.ts`.
