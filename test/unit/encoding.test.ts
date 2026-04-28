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

  it('classifies a single NUL byte as binary', () => {
    assert.strictEqual(classifyBlob(Buffer.from([0])), 'binary');
  });

  it('classifies pure ASCII as text', () => {
    assert.strictEqual(classifyBlob(Buffer.from('plain ascii line\n')), 'text');
  });

  it('classifies UTF-8 with 4-byte code points as text', () => {
    // U+1F600 GRINNING FACE → F0 9F 98 80
    assert.strictEqual(classifyBlob(Buffer.from('emoji: 😀', 'utf8')), 'text');
  });

  it('detects NUL exactly at the last byte of the sniff window', () => {
    const buf = Buffer.alloc(8 * 1024, 0x61); // 8KB of 'a'
    buf[8 * 1024 - 1] = 0;
    assert.strictEqual(classifyBlob(buf), 'binary');
  });

  it('ignores NULs past the sniff window (>8KB)', () => {
    const buf = Buffer.alloc(8 * 1024 + 16, 0x61); // 8KB + 16 of 'a'
    buf[8 * 1024 + 8] = 0;
    assert.strictEqual(classifyBlob(buf), 'text');
  });

  it('classifies a lone UTF-8 continuation byte as nonUtf8', () => {
    // 0x80 is a continuation byte with no leading byte.
    assert.strictEqual(classifyBlob(Buffer.from([0x80])), 'nonUtf8');
  });

  it('classifies a truncated multi-byte UTF-8 sequence as nonUtf8', () => {
    // 0xe6 starts a 3-byte sequence; only one continuation byte follows.
    assert.strictEqual(classifyBlob(Buffer.from([0x61, 0xe6, 0x97])), 'nonUtf8');
  });

  it('classifies UTF-8 BOM-prefixed text as text', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi', 'utf8')]);
    assert.strictEqual(classifyBlob(buf), 'text');
  });

  it('classifies CR/LF/tab control chars as text', () => {
    assert.strictEqual(classifyBlob(Buffer.from('a\r\nb\tc\n')), 'text');
  });
});
