import { main } from './cli';

const controller = new AbortController();
process.once('SIGINT', () => {
  process.stderr.write('\nStopping after the current request. Progress is saved; run the same command again to continue.\n');
  controller.abort();
});

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

process.exitCode = await main(
  process.argv.slice(2),
  process.env,
  { out: (line) => console.log(line), err: (line) => console.error(line), readStdin },
  { signal: controller.signal },
);
