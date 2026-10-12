import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secret } from '../src/env.js';

test('a secret comes from the variable, or from the file the variable names, trimmed, with \\n unescaped', () => {
  process.env.T_PLAIN = 'line1\\nline2';
  assert.equal(secret('T_PLAIN'), 'line1\nline2');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'));
  const file = path.join(dir, 'tok'); fs.writeFileSync(file, 'abc123\n');
  process.env.T_FILE_FILE = file;
  assert.equal(secret('T_FILE'), 'abc123');
  assert.equal(secret('T_ABSENT'), undefined);
  assert.throws(() => secret('T_ABSENT', { required: true }), /T_ABSENT \(or T_ABSENT_FILE\) is not set/);
  fs.rmSync(dir, { recursive: true });
});
