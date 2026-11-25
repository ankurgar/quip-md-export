import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ExportEvent, ExportOptions, ExportSummary, Plan } from '../core/exporter';
import { AuthError, QuipClient } from '../core/quipClient';
import { parseQuipUrl, rootChoices } from '../core/roots';
import { createSession, type SessionConfig } from '../core/session';
import { parseHtmlWithJsdom } from './jsdomParser';
import { NodeFsSink } from './nodeSink';

export const USAGE = `Quip to Markdown exporter (command line)

Copies your Quip folders and documents into a folder as Markdown, using exactly the same code as the browser
extension. It only ever reads from Quip. Run it again to continue or to pick up changes; nothing is deleted
and files this tool did not write are never overwritten.

Usage:
  QUIP_TOKEN=... npm run cli -- --out <folder> [options]
  echo "$TOKEN" | npm run cli -- --out <folder> --token-stdin [options]

Create a token at https://<your-site>.quip.com/dev/token. It is read from the QUIP_TOKEN environment variable
or from standard input and is never printed.

Options:
  -o, --out <folder>   Where to write the Markdown (created if missing). Required.
      --from <url>     Export only this Quip document or folder (everything inside it) instead of the account.
      --limit <n>      Export at most n documents (good for a trial run).
      --scan-only      Read the folder structure and report what would be exported, without writing anything.
      --force          Export every document again, even if it is unchanged since the last run.
      --no-comments    Leave out comments and conversation.
      --no-raw         Do not keep Quip's original HTML and metadata (.quip-raw).
      --no-xlsx        Do not save spreadsheets as .xlsx next to their notes.
      --no-unfiled     Do not export documents you wrote that are in no folder.
      --token-stdin    Read the token from standard input instead of QUIP_TOKEN.
  -h, --help           Show this help.

Exit status: 0 done, 1 finished with failed documents, 2 bad arguments or nothing to export,
3 Quip rejected the token, 130 stopped (Ctrl-C).
`;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  readStdin(): Promise<string>;
}

export interface CliDeps {
  baseUrl?: string;
  signal?: AbortSignal;
  /** Transport overrides, for tests. */
  client?: SessionConfig['client'];
}

const isAbort = (err: unknown): boolean => err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

const describe = (err: unknown): string =>
  err instanceof AuthError ? 'Quip rejected the access token. Create a new one at /dev/token and try again.' : err instanceof Error ? err.message : String(err);

const codeFor = (err: unknown): number => (err instanceof AuthError ? 3 : isAbort(err) ? 130 : 1);

function planLines(plan: Plan): string[] {
  const lines = [`${plan.threads.length} documents in ${plan.folders.length} folders would be exported.`];
  if (plan.unfiled > 0) lines.push(`${plan.unfiled} documents you wrote are in no folder (they go under "_Unfiled").`);
  if (plan.othersUnfiled > 0) lines.push(`${plan.othersUnfiled} documents by other people are in none of your folders and are not exported.`);
  if (plan.relocated.length > 0) lines.push(`${plan.relocated.length} documents get a new file name or folder; the old copy stays.`);
  const unreadable = plan.unreadableFolders.length + plan.unreadableThreads.length;
  if (unreadable > 0) lines.push(`${unreadable} items cannot be read with this token and will be listed in the report.`);
  if (plan.unreadableFolders.length + plan.unreadableUnselected.length > 0) lines.push('Some folders cannot be read, so documents inside them may be exported under "_Unfiled".');
  lines.push(`About ${plan.estimatedRequests} Quip API requests. How long that takes depends on the speed Quip allows for your account; it is paced automatically.`);
  return lines;
}

function summaryLines(summary: ExportSummary): string[] {
  const d = summary.docs;
  const parts = [`${d.exported} saved`, `${d.skipped} unchanged`, `${d.failed} failed`];
  if (d.notAttempted > 0) parts.push(`${d.notAttempted} not attempted`);
  const lines = [`${summary.stopReason === 'completed' ? 'Done' : 'Stopped'}. ${parts.join(', ')} of ${d.planned} documents.`];
  lines.push(`Attachments: ${summary.attachments.saved} saved, ${summary.attachments.reused} reused, ${summary.attachments.missing} unavailable. Comments exported: ${summary.comments}.`);
  const embeds = Object.entries(summary.embeds).map(([type, n]) => `${type} ${n}`);
  if (embeds.length > 0) lines.push(`Embedded content converted: ${embeds.join(', ')}.`);
  for (const [code, group] of Object.entries(summary.warnings)) lines.push(`Warning ${code} (${group.count}): ${group.examples.slice(0, 3).join('; ')}`);
  if (summary.unresolvedLinks.length > 0) lines.push(`${summary.unresolvedLinks.length} links point to documents outside this export and still use their Quip address.`);
  for (const f of summary.failures.slice(0, 20)) lines.push(`FAILED ${f.title} (${f.id}) at ${f.stage}: ${f.message}`);
  if (summary.failures.length > 20) lines.push(`... and ${summary.failures.length - 20} more failures; see the report.`);
  lines.push(`Report: ${summary.reportPath}`);
  return lines;
}

/** Runs the command line tool. Returns the process exit status. */
export async function main(argv: string[], env: Record<string, string | undefined>, io: CliIo, deps: CliDeps = {}): Promise<number> {
  let values;
  try {
    values = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        out: { type: 'string', short: 'o' },
        from: { type: 'string' },
        limit: { type: 'string' },
        'scan-only': { type: 'boolean' },
        force: { type: 'boolean' },
        'no-comments': { type: 'boolean' },
        'no-raw': { type: 'boolean' },
        'no-xlsx': { type: 'boolean' },
        'no-unfiled': { type: 'boolean' },
        'token-stdin': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (err) {
    io.err(`${describe(err)}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  if (!values.out) {
    io.err(`Say where to write with --out <folder>.\n\n${USAGE}`);
    return 2;
  }
  const outDir = resolve(values.out);
  if (outDir === '/' || outDir === homedir()) {
    io.err('Choose a folder of its own for the export, not the root or your home folder.');
    return 2;
  }
  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number.parseInt(values.limit, 10);
    if (!Number.isFinite(limit) || limit < 1 || String(limit) !== values.limit.trim()) {
      io.err('--limit needs a whole number of 1 or more.');
      return 2;
    }
  }
  const token = (values['token-stdin'] ? await io.readStdin() : (env.QUIP_TOKEN ?? '')).trim();
  if (!token) {
    io.err('No token. Put it in the QUIP_TOKEN environment variable, or pipe it in with --token-stdin. Create one at https://<your-site>.quip.com/dev/token.');
    return 2;
  }

  const transport = { ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}), ...(deps.signal ? { signal: deps.signal } : {}) };
  try {
    const lookup = new QuipClient({ token, ...transport, ...deps.client });
    const user = await lookup.currentUser();
    io.out(`Connected as ${user.name || 'your account'}${user.siteUrl ? ` (${new URL(user.siteUrl).host})` : ''}.`);

    const roots = rootChoices(user);
    let rootIds = roots.filter((r) => r.defaultOn).map((r) => r.id);
    let threadIds: string[] = [];
    let includeUnfiled = !values['no-unfiled'];
    if (values.from) {
      const link = parseQuipUrl(values.from);
      if (!link) {
        io.err(`"${values.from}" is not a Quip document or folder address.`);
        return 2;
      }
      const folder = await lookup.getFolder(link.id);
      if (folder.ok) {
        rootIds = [folder.value.id];
        io.out(`Exporting the folder "${folder.value.title}" and everything inside it.`);
      } else {
        const thread = await lookup.getThread(link.id);
        if (!thread.ok || thread.value.type === 'chat') {
          io.err(thread.ok ? 'That page is a chat, which cannot be exported.' : `That page cannot be read with this token (HTTP ${thread.status || 'no response'}).`);
          return 2;
        }
        rootIds = [];
        threadIds = [thread.value.id];
        io.out(`Exporting the document "${thread.value.title}".`);
      }
      includeUnfiled = false;
    }

    const options: Partial<ExportOptions> = {
      rootIds,
      threadIds,
      includeUnfiled,
      allRootIds: roots.filter((r) => r.kind !== 'starred').map((r) => r.id),
      ownerId: user.id,
      includeComments: !values['no-comments'],
      keepRaw: !values['no-raw'],
      saveXlsx: !values['no-xlsx'],
      skipUnchanged: !values.force,
      ...(limit !== undefined ? { maxDocs: limit } : {}),
      ...(user.siteUrl ? { siteUrl: user.siteUrl } : {}),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };

    const sink = new NodeFsSink(outDir);
    await sink.ensureDir('');
    let skipped = 0;
    const onEvent = (e: ExportEvent): void => {
      switch (e.type) {
        case 'phase':
          io.out(`[${e.phase}] ${e.message}`);
          break;
        case 'doc':
          if (e.status === 'skipped') {
            skipped += 1;
            if (skipped % 100 === 0) io.out(`[${e.index}/${e.total}] ${skipped} unchanged so far`);
          } else io.out(`[${e.index}/${e.total}] ${e.status === 'failed' ? 'FAILED' : 'saved'} ${e.path}${e.message ? ` (${e.message})` : ''}`);
          break;
        case 'throttle':
          io.out(`[rate limit] waiting ${Math.max(1, Math.round(e.waitMs / 1000))} s (${e.reason})`);
          break;
        case 'log':
          io.out(`[${e.level}] ${e.message}`);
          break;
      }
    };
    const { exporter } = createSession({
      token,
      ...transport,
      sink,
      parseHtml: parseHtmlWithJsdom,
      options,
      onEvent,
      ...(deps.client ? { client: deps.client } : {}),
    });

    if (values['scan-only']) {
      for (const line of planLines(await exporter.scan())) io.out(line);
      io.out('Nothing was written.');
      return 0;
    }
    const summary = await exporter.run();
    for (const line of summaryLines(summary)) io.out(line);
    if (summary.stopReason === 'aborted') return 130;
    return summary.docs.failed > 0 ? 1 : 0;
  } catch (err) {
    io.err(describe(err));
    return codeFor(err);
  }
}
