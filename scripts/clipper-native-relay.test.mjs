import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeFrames } from './clipper-native-relay.mjs';

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

test('partial headers, bodies and adjacent native messages retain exact wire bytes', () => {
  const first = frame({ _messageId: 9, title: 'Первый 🐄' });
  const second = frame({ _messageId: 10, outcome: 'committed' });
  const transport = new NativeFrames();
  assert.deepEqual(transport.push(first.subarray(0, 2)), []);
  assert.deepEqual(transport.push(first.subarray(2, 7)), []);
  const result = transport.push(Buffer.concat([first.subarray(7), second]));
  assert.deepEqual(result.map(item => item.message._messageId), [9, 10]);
  assert.deepEqual(result.map(item => item.frame), [first, second]);
  assert.equal(transport.buffer.length, 0);
});
