// SC0 characterization only: a real browser directory and an external Node writer.
// All writes are limited to a new, disposable fixture created by this process.
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { platform, release } from 'node:os';

if (process.argv.includes('--help')) {
  console.log('node scripts/sc0-fsa-probe.mjs\nOpen the printed loopback URL in a disposable headed browser.\nChoose the exact printed fixture directory, allow read/write, then run probes.\nResults remain under output/playwright/. Ctrl-C stops the server.');
  process.exit(0);
}
if (process.argv.length > 2) throw new Error('No arguments accepted; see --help');

const output = fileURLToPath(new URL('../output/playwright/', import.meta.url));
await mkdir(output, { recursive: true });
const run = await mkdtemp(join(output, 'sc0-fsa-'));
const vault = join(run, 'disposable-vault');
await mkdir(vault);
const token = randomBytes(32).toString('hex');
await writeFile(join(vault, '.mine-sc0-probe'), token, { flag: 'wx' });
const files = { B1: 'B1-visible.md', B2: 'B2-race.md', B3: 'B3-exclusive.md' };
const html = await readFile(new URL('./sc0-fsa-probe.html', import.meta.url), 'utf8');
let origin;
let reportWritten = false;

async function readFixture(id) {
  if (!Object.hasOwn(files, id)) throw new Error('Unknown probe');
  try {
    const bytes = await readFile(join(vault, files[id]));
    return { exists: true, size: bytes.length, text: bytes.toString('utf8') };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false };
    throw error;
  }
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32768) throw new Error('Report too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (request, response) => {
  const reply = (status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  try {
    // No CORS, arbitrary paths or remote hostnames. Mutation needs this run's token.
    if (request.headers.host !== new URL(origin).host) return reply(403, { error: 'Host rejected' });
    if (request.url === '/' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(html.replace('__PROBE_CONFIG__', JSON.stringify({ token, vault, files }).replaceAll('<', '\\u003c')));
      return;
    }
    if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['x-sc0-token'] !== token) {
      return reply(403, { error: 'Only same-origin authenticated probes are accepted' });
    }
    const body = await readJson(request);
    // Verify fixture identity before every write; never follow client-supplied paths.
    if (await readFile(join(vault, '.mine-sc0-probe'), 'utf8') !== token) throw new Error('Fixture identity changed');
    if (request.url === '/read') return reply(200, await readFixture(body.id));
    if (request.url === '/external-create' && body.id === 'B2') {
      await writeFile(join(vault, files.B2), 'EXTERNAL-B2', { flag: 'wx' });
      return reply(200, await readFixture('B2'));
    }
    if (request.url === '/external-write' && body.id === 'B3') {
      await writeFile(join(vault, files.B3), 'EXTERNAL-B3', { flag: 'r+' });
      return reply(200, await readFixture('B3'));
    }
    if (request.url === '/report' && !reportWritten) {
      const result = {
        kind: 'SC0 filesystem characterization, not product acceptance',
        recordedAt: new Date().toISOString(),
        node: process.version,
        os: `${platform()} ${release()}`,
        fixture: vault,
        browser: body,
        disk: Object.fromEntries(await Promise.all(Object.keys(files).map(async id => [id, await readFixture(id)]))),
      };
      const reportPath = join(run, 'results.json');
      await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
      reportWritten = true;
      console.log(JSON.stringify({ reportPath, result }, null, 2));
      return reply(200, { reportPath });
    }
    reply(404, { error: 'Unknown or completed probe' });
  } catch (error) {
    reply(400, { error: error.message, code: error.code });
  }
});
server.listen(0, '127.0.0.1', () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  console.log(JSON.stringify({ url: origin, chooseOnlyThisDirectory: vault, output: run }));
});
