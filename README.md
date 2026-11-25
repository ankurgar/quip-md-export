# Quip → Markdown exporter

A Chrome (Manifest V3) extension that copies your Quip folders and documents into a folder on your computer as Markdown, keeping Quip's folder structure. It also converts embedded content that other exporters drop: **calendars, Kanban boards, project trackers, process bars, embedded and standalone spreadsheets**, comments, images and file attachments.

**It is read-only.** It cannot create, edit or delete anything in Quip, and it never deletes files from your target folder or overwrites a file it did not create. See [Read-only guarantees](#read-only-guarantees).

Quip is being retired. [Salesforce's notice](https://help.salesforce.com/s/articleView?id=005299603&language=en_US&type=1) says subscriptions cannot be renewed after 1 March 2027 and gives 31 March 2027 as the date after which an instance is no longer accessible; your own deadline is whichever applies to your account. Export while you can still sign in.

## Quick start

```bash
npm ci
npm run build          # writes the extension to dist/
```

1. In Chrome or Edge open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, choose **Load unpacked** and pick the `dist/` folder. (The exporter uses an API token, not your browser session, so it works in any Chromium browser. In Dia 1.58 the extension loaded when Dia was started with `--load-extension=<path to dist>`, and its page and read-only guard worked; "Load unpacked" from Dia's own extensions page was not tried.)
2. While signed in to Quip, open `https://<your-site>.quip.com/dev/token` (or `quip.com/dev/token`) and copy a personal access token. Generating a new token invalidates the previous one, [according to ClonePartner's guide](https://clonepartner.com/blog/how-to-export-data-from-quip-methods-api-limits-migration-prep).
3. Click the extension's toolbar icon. If a Quip page is open when you click, you can export just that document or folder.
4. Paste the token, **Connect**, **Choose folder…**, then **Scan** (nothing is written yet) and **Start export**.

For a first run, tick *Limit to the first N documents* and try 5. Keep the tab open while it runs; you can stop at any time and continue later, and finished documents are not downloaded again.

**Keep the exporter tab on screen while it runs.** Browsers pause pages that are not visible. In Dia, an exporter tab that was not on screen (another tab selected, or its window covered, minimized or on another desktop) managed one request every minute or so and stalled for minutes at a time. Select the exporter tab in a window you can see, or use the command line below, which does not depend on a tab.

## Without a browser (command line)

The same exporter code also runs from a terminal, which suits a long export: nothing needs to stay on screen, and the folder is written directly (no folder picker).

```bash
npm ci
echo "$QUIP_TOKEN" | npm run cli -- --out ~/quip-export --token-stdin --scan-only   # look first; writes nothing
echo "$QUIP_TOKEN" | npm run cli -- --out ~/quip-export --token-stdin --from https://<site>.quip.com/<document or folder>
echo "$QUIP_TOKEN" | npm run cli -- --out ~/quip-export --token-stdin                # everything
npm run cli -- --help
```

The token comes from standard input (`--token-stdin`) or the `QUIP_TOKEN` environment variable and is never printed. The command writes the same layout and report as the extension, only ever sends `GET` requests through the same client, can be stopped with Ctrl-C and run again to continue, and takes `--limit`, `--force`, `--no-comments`, `--no-raw`, `--no-xlsx` and `--no-unfiled`. It runs on Node 20 or later and uses jsdom to read Quip's HTML.

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

- A note this tool wrote is updated in place when the document changed in Quip, when a note it links to appeared, moved or was renamed (so its relative links stay right), when an attachment, `.xlsx` or raw file it links to or archives was deleted, or when you changed the options that affect its content. If nothing changed in Quip, nothing is written, whatever you did to the file.
- **What you changed is yours.** The tool remembers what it wrote (a fingerprint of each note, `.xlsx` and PDF). If you edited or replaced one and Quip later changes that document, your file is left exactly as it is and the new version is written beside it under a numbered name such as `Notes (3).md`; the report lists it. From then on the numbered copy is the one that gets updated.
- A file this tool did *not* write is never overwritten. That is checked on every run, for every note, and once more right before each write: if something else is now where a note used to be, or appears there while the export runs, the note takes a numbered name instead. A note is recognised as the tool's own by the front matter at its top (`quip_id`), not by a line somewhere in its text; a report that is not the tool's own stays untouched and the new one is written as `_Quip export report (2).md`. Inside its own `.quip-raw` and `.quip-md-export` folders the tool replaces files freely; they are its working area. The names `_attachments`, `_Unfiled` and `_Quip export report.md` are reserved. If a file appears at a note's name while an export is running, notes written earlier that link to that name are corrected on the next run.
- A document renamed or moved in Quip gets a new file; the old copy stays where it was (nothing is deleted) and is listed in the report. The same happens when its old file name was taken, edited or replaced.
- Only one exporter tab can write at a time (a browser lock): a second tab asks you to wait, so two tabs can never choose the same name for different documents. A tab that scanned before another tab exported plans again when you press Start, so it never works from an out-of-date picture.
- Attachments and spreadsheets Quip refuses (HTTP 403 or 404) are listed in the report and not asked for again on every run; network errors and server errors are retried automatically. Untick *Skip unchanged* to try everything again.
- *Keep Quip's original HTML* (`.quip-raw`): turning it off does not re-export anything and turning it on does; if you delete the folder while the option is on, those documents are fetched again, so untick the option first if you want the space back.
- "Unfiled" means documents you wrote that are in no folder anywhere in your account (Starred is a view, not a folder, so a document that is only starred counts as unfiled; Trash does count as a folder, so deleted documents are left out). Documents other people wrote that are in none of your folders are counted in the scan but not exported. If a folder cannot be read, what is inside it is unknown, so a document you wrote there can appear under `_Unfiled`; the scan summary says so before anything is written (untick the option to leave them out), and the report lists the folders.

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

1. **The client can only read.** Every request is a `GET` without a body, sent only to an allow-list of read endpoints; identifiers are validated so they cannot smuggle in another path (`src/core/quipClient.ts`). JSON endpoints never follow a redirect. A file download may be redirected by Quip and the browser follows it (a browser cannot inspect a redirect before following it); that hop is also a `GET`, must be HTTPS, and the page's policy below only lets it reach Quip's API host. A response that is not the kind of file that was asked for (a `.xlsx` that is not a workbook, a PDF that is not a PDF) is reported as a failure instead of being saved; a JSON attachment shaped like a Quip error report is kept, and flagged `attachment-suspect`.
2. **The browser enforces it too.** The extension registers a `declarativeNetRequest` rule that blocks every `POST`, `PUT`, `PATCH`, `DELETE` and other non-read request that the extension itself sends to *any* address, so even a future bug could not modify a document. The page shows "Browser-level read-only guard: on".
3. **The pages cannot be steered by document content.** The extension pages run under a strict Content Security Policy: scripts, styles and images only from the extension itself, no frames, no forms, and network access only to `https://platform.quip.com`. Quip HTML is parsed into an inert document and only its text and attributes are read; it is never inserted into the page.
4. **Tests prove it.** The mock Quip server records every request and the tests require zero non-GET requests. The real-browser tests show that writes (`POST`, `PUT`, `PATCH`, `DELETE`) are blocked before they leave the browser, even to an address the extension has no permission for, and that documents full of images, frames, scripts, stylesheets and other tags that normally make a browser fetch something cause no request at all. Static checks forbid any other HTTP method, body, `XMLHttpRequest`, WebSocket or file deletion in shipped code, and `npm run verify-build` checks the bundle for test hooks, `eval` and unexpected hosts, and the manifest for extra permissions and a weakened policy.

Permissions requested: `storage` (settings), `activeTab` (to offer the page you were viewing), `declarativeNetRequest` (the guard) and access to `https://platform.quip.com/*` only. No content scripts, no analytics, nothing is sent anywhere except to Quip. [Chrome describes](https://developer.chrome.com/docs/extensions/reference/permissions-list) `declarativeNetRequest` to the user as "Block content on any page"; the extension uses it only to block its own write requests. The narrower `declarativeNetRequestWithHostAccess` was tried first, but it only covers hosts the extension has permission for, so it could not make the "any address" promise.

## Rate limits and time

Quip rate-limits the API and reports what is left in the headers of every response. On the account this was tested with, the limits were **200 requests a minute per user and 600 a minute per company**, in windows that reset on the minute (older Quip documentation says 50 a minute and 750 an hour, so your account may differ). The exporter reads those headers on every response and spreads the requests that are left over the time that is left, so it uses what the account allows without exceeding it; a pool with none left blocks until its reset, and a 429 or 503 is waited out as the server asks. Quip also sends a `Retry-After` on every *successful* response (it is the time until the window resets), and the exporter correctly ignores it there; an early version treated it as "stop" and spent about a minute per request.

A document needs about 2 requests (content and comments), plus one per attachment and one for a spreadsheet's `.xlsx`. The tested account (418 documents in 88 folders, 82 spreadsheets, 215 attachments) took about 850 requests and **10 minutes** for the whole export, with no rate-limit pauses. Unchanged documents are skipped on later runs. A request that does not start answering within two minutes is abandoned and retried.

## Token handling

The token is kept in browser session storage and disappears when the browser closes. Tick *Remember* to also keep it in the extension's local storage (unencrypted, inside your browser profile); unticking it removes the stored copy immediately. **Forget token** wipes it from the page and from both kinds of storage at once and disconnects. If Quip rejects the token during an export, the export stops, nothing further is attempted, and the report says how many documents were left. The `/dev/token` page only has a "Get Personal Access Token" button (no revoke button); according to [ClonePartner's guide](https://clonepartner.com/blog/how-to-export-data-from-quip-methods-api-limits-migration-prep), generating another token invalidates the previous one, which is the way to retire a token you are finished with.

## Known limits

- **Tested against one real account.** All 418 documents of a personal account exported with no failures, and every relative link and image in the result resolves. A comparison of the words in each document's original HTML with its note found no lost text apart from live-app markup that has since been handled. Quip's HTML varies by content, so other accounts may contain things this has not seen (the report lists unknown embedded apps as `unknown-live-app`, and the original HTML is kept in `.quip-raw/` so conversion can be improved). Start with a small trial.
- Quip's API is [licensed per plan](https://quip.com/dev/automation/documentation/current#section/License-Requirements). If your account cannot create a token, this tool cannot read it.
- A document can be reached through several Quip addresses. Links are matched by the document id, its current share address and the address Quip reports as its link; a link that uses any other one (for example a previous, replaced share address) stays a Quip URL and is listed in the report.
- If Quip ever serves an attachment from a host other than `platform.quip.com` (its API documents a direct response), the page's policy blocks the download and the attachment is listed as failed in the report. Widen `connect-src` in `extension/manifest.json` if that happens.
- Project tracker dates are stored by Quip as timestamps and are shown as the calendar day in your browser's time zone. When the stored instant is neither midnight in that zone nor UTC midnight, the day is a best guess (it can be one day off for an author far from your time zone) and the report lists it as `ambiguous-date`. Documents with a project tracker are exported again if your browser's time zone changes.
- Comments are fetched newest first by timestamp. If a whole page of comments shares one microsecond timestamp, Quip offers no way to page past it, so the report warns `comments-incomplete`; this is not expected in practice.
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
- `src/node/` is the command line version (`cli.ts`, a Node file sink and a jsdom parser); `npm run build:cli` writes `dist-cli/cli.mjs`.
- `tests/mock/` is a synthetic Quip API (users, folders, paginated HTML, messages, blobs, 503 throttling, failure injection) used by both the integration and browser tests, which require the browser export to match the Node export file for file.

To add support for another embedded type, extend `src/core/convert/liveApps.ts` and add a case to `tests/unit/liveApps.test.ts`.
