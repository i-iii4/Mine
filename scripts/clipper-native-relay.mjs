// Test-only native messaging launcher. The shipped host executes every request;
// only response delivery is interrupted, after an observed source commit.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export class NativeFrames {
  buffer = Buffer.alloc(0);
  push(bytes) {
    this.buffer = Buffer.concat([this.buffer, bytes]);
    const frames = [];
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if (size > 64 * 1024 * 1024) throw new Error('Native message exceeds test transport limit');
      if (this.buffer.length < size + 4) break;
      const frame = this.buffer.subarray(0, size + 4);
      frames.push({ frame, message: JSON.parse(frame.subarray(4).toString()) });
      this.buffer = this.buffer.subarray(size + 4);
    }
    return frames;
  }
}

function relay([host, fixtureVault, log, fault, ...origin]) {
  const child = spawn(host, origin, { stdio: ['pipe', 'pipe', 'pipe'] });
  const requests = new Map();
  const input = new NativeFrames();
  const output = new NativeFrames();
  const record = event => appendFileSync(log, `${JSON.stringify(event)}\n`);
  const stop = () => { child.kill('SIGTERM'); process.exit(0); };
  child.stderr.on('data', bytes => process.stderr.write(bytes));
  process.stdin.on('data', bytes => {
    for (const { frame, message } of input.push(bytes)) {
      requests.set(message._messageId, message);
      record({ kind: 'request', message });
      // Optional diagnostics and the user's known-space list are outside this
      // fixture. Do not dispatch the optional diagnostic write or known-space read.
      if (['confirm_connection_check', 'list_known_vaults'].includes(message.action)) continue;
      if (!['get_status', 'list_channels', 'create_channel', 'save_block', 'get_save_operation'].includes(message.action)
        || message.vault_path !== fixtureVault) {
        record({ kind: 'out-of-fixture-request-blocked', action: message.action });
        stop();
        return;
      }
      if (message.action === 'get_save_operation' && existsSync(fault)) {
        record({ kind: 'lookup-delivery-interrupted', message });
        stop();
        return;
      }
      child.stdin.write(frame);
    }
  });
  child.stdout.on('data', bytes => {
    for (const { frame, message } of output.push(bytes)) {
      const request = requests.get(message._messageId);
      if (request?.action === 'save_block' && message.outcome === 'committed' && existsSync(`${fault}.armed`)) {
        writeFileSync(fault, JSON.stringify({ operationId: request.operation_id, slug: message.slug }));
        record({ kind: 'committed-response-dropped', request, response: message });
        stop();
        return;
      }
      record({ kind: 'response', message: { _messageId: message._messageId, operation_id: message.operation_id,
        outcome: message.outcome, ok: message.ok, slug: message.slug, code: message.code } });
      process.stdout.write(frame);
    }
  });
  process.stdin.on('end', () => child.stdin.end());
  child.on('error', error => { process.stderr.write(String(error)); process.exit(1); });
  child.on('exit', code => process.exit(code ?? 1));
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) relay(process.argv.slice(2));
