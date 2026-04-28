import * as assert from 'assert';
import { classifyBlob } from '../../src/util/encoding';

describe('classifyBlob', () => {
  it('classifies UTF-8 text as text', () => {
    assert.strictEqual(classifyBlob(Buffer.from('hello world\nこんにちは', 'utf8')), 'text');
  });

  it('classifies empty buffer as text', () => {
    assert.strictEqual(classifyBlob(Buffer.alloc(0)), 'text');
  });

  it('classifies a buffer containing NUL as binary', () => {
    const b = Buffer.concat([Buffer.from('hello'), Buffer.from([0]), Buffer.from('world')]);
    assert.strictEqual(classifyBlob(b), 'binary');
  });

  it('classifies PNG header bytes as binary', () => {
    // PNG signature contains a NUL very early.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    assert.strictEqual(classifyBlob(png), 'binary');
  });

  it('classifies UTF-16 BOM-only as binary (NUL bytes)', () => {
    // UTF-16 LE encoding of "hi" is 68 00 69 00 — has NULs.
    const utf16 = Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    assert.strictEqual(classifyBlob(utf16), 'binary');
  });

  it('classifies latin-1 (no NULs, invalid UTF-8) as nonUtf8', () => {
    // 0xe9 = é in latin-1, but a lone continuation byte in UTF-8.
    const latin1 = Buffer.from([0x68, 0x69, 0xe9]);
    assert.strictEqual(classifyBlob(latin1), 'nonUtf8');
  });
});
