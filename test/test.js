const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const vm = require('vm');

const rsPath = path.join(__dirname, '..', 'shared', 'reedsolomon.js');
const rsCode = fs.readFileSync(rsPath, 'utf8');
vm.runInThisContext(rsCode);
const protocolV3Path = path.join(__dirname, '..', 'shared', 'protocol-v3.js');
const protocolV3Code = fs.readFileSync(protocolV3Path, 'utf8');
vm.runInThisContext(protocolV3Code);

function strToBytes(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

function bytesToStr(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let str = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    str += String.fromCharCode.apply(null, slice);
  }
  return Buffer.from(str, 'binary').toString('base64');
}

function simpleHash(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

describe('GF(256) arithmetic', () => {
  it('mul(a,0) = 0', () => {
    assert.strictEqual(ReedSolomon._GF.mul(5, 0), 0);
    assert.strictEqual(ReedSolomon._GF.mul(0, 5), 0);
  });

  it('mul(1,x) = x', () => {
    for (let x = 1; x < 256; x++) {
      assert.strictEqual(ReedSolomon._GF.mul(1, x), x);
    }
  });

  it('mul(a,b) = mul(b,a)', () => {
    for (let a = 1; a < 20; a++) {
      for (let b = 1; b < 20; b++) {
        assert.strictEqual(ReedSolomon._GF.mul(a, b), ReedSolomon._GF.mul(b, a));
      }
    }
  });

  it('mul(a, inv(a)) = 1', () => {
    for (let a = 1; a < 256; a++) {
      const inv = ReedSolomon._GF.inv(a);
      assert.strictEqual(ReedSolomon._GF.mul(a, inv), 1, `inv failed for a=${a}`);
    }
  });

  it('div(a,b) * b = a', () => {
    for (let a = 1; a < 50; a++) {
      for (let b = 1; b < 50; b++) {
        assert.strictEqual(ReedSolomon._GF.mul(ReedSolomon._GF.div(a, b), b), a);
      }
    }
  });
});

describe('Reed-Solomon encode', () => {
  it('returns empty array for no data', () => {
    assert.deepStrictEqual(ReedSolomon.encode([], 5), []);
  });

  it('returns correct number of parity chunks', () => {
    const data = [strToBytes('abc'), strToBytes('def')];
    const parity = ReedSolomon.encode(data, 5);
    assert.strictEqual(parity.length, 5);
    parity.forEach(p => assert.ok(p instanceof Uint8Array));
  });

  it('parity chunks have same length as longest data chunk', () => {
    const data = [strToBytes('hello'), strToBytes('hi')];
    const parity = ReedSolomon.encode(data, 2);
    parity.forEach(p => assert.strictEqual(p.length, 5));
  });

  it('deterministic — same input gives same output', () => {
    const data = [strToBytes('test1'), strToBytes('test2'), strToBytes('test3')];
    const p1 = ReedSolomon.encode(data, 3);
    const p2 = ReedSolomon.encode(data, 3);
    for (let i = 0; i < p1.length; i++) {
      assert.deepStrictEqual(p1[i], p2[i]);
    }
  });
});

describe('Reed-Solomon decode — no missing chunks', () => {
  it('returns original data when all chunks present', () => {
    const data = [strToBytes('aaa'), strToBytes('bbb'), strToBytes('ccc')];
    const result = ReedSolomon.decode(data, [0, 1, 2], 3);
    assert.ok(result);
    for (let i = 0; i < 3; i++) {
      assert.deepStrictEqual(result[i], data[i], `chunk ${i} mismatch`);
    }
  });
});

describe('Reed-Solomon decode — recovery scenarios', () => {
  const data = [];
  for (let i = 0; i < 7; i++) {
    data.push(strToBytes('chunk' + i + '_' + 'x'.repeat(50)));
  }

  it('recovers 1 missing chunk using 1 parity', () => {
    const parity = ReedSolomon.encode(data, 10);
    const avail = [...data.slice(0, 6), parity[0]];
    const indices = [0, 1, 2, 3, 4, 5, 7];
    const result = ReedSolomon.decode(avail, indices, 7);
    assert.ok(result);
    for (let i = 0; i < 7; i++) {
      assert.deepStrictEqual(result[i], data[i], `chunk ${i}`);
    }
  });

  it('recovers 2 missing chunks using 2 parity', () => {
    const parity = ReedSolomon.encode(data, 10);
    const avail = [...data.slice(0, 5), parity[0], parity[1]];
    const indices = [0, 1, 2, 3, 4, 7, 8];
    const result = ReedSolomon.decode(avail, indices, 7);
    assert.ok(result);
    for (let i = 0; i < 7; i++) {
      assert.deepStrictEqual(result[i], data[i], `chunk ${i}`);
    }
  });

  it('recovers 5 missing chunks using 5 parity', () => {
    const parity = ReedSolomon.encode(data, 10);
    const avail = [data[0], data[1], parity[0], parity[1], parity[2], parity[3], parity[4]];
    const indices = [0, 1, 7, 8, 9, 10, 11];
    const result = ReedSolomon.decode(avail, indices, 7);
    assert.ok(result);
    for (let i = 0; i < 7; i++) {
      assert.deepStrictEqual(result[i], data[i], `chunk ${i}`);
    }
  });

  it('recovers all 7 data chunks from parity only', () => {
    const parity = ReedSolomon.encode(data, 10);
    const avail = parity.slice(0, 7);
    const indices = [7, 8, 9, 10, 11, 12, 13];
    const result = ReedSolomon.decode(avail, indices, 7);
    assert.ok(result);
    for (let i = 0; i < 7; i++) {
      assert.deepStrictEqual(result[i], data[i], `chunk ${i}`);
    }
  });

  it('returns null when not enough chunks', () => {
    const parity = ReedSolomon.encode(data, 2);
    const result = ReedSolomon.decode([parity[0]], [7], 7);
    assert.strictEqual(result, null);
  });

  it('returns null when not enough chunks (6 of 7)', () => {
    const parity = ReedSolomon.encode(data, 2);
    const avail = [...data.slice(0, 4), parity[0], parity[1]];
    const result = ReedSolomon.decode(avail, [0, 1, 2, 3, 7, 8], 7);
    assert.strictEqual(result, null);
  });
});

describe('Reed-Solomon — parity > data', () => {
  it('works when parity count exceeds data count', () => {
    const data = [strToBytes('ab'), strToBytes('cd'), strToBytes('ef')];
    const parity = ReedSolomon.encode(data, 10);
    assert.strictEqual(parity.length, 10);

    const avail = [parity[0], parity[1], parity[2]];
    const result = ReedSolomon.decode(avail, [3, 4, 5], 3);
    assert.ok(result);
    for (let i = 0; i < 3; i++) {
      assert.deepStrictEqual(result[i], data[i], `chunk ${i}`);
    }
  });
});

describe('Reed-Solomon — uneven chunk lengths', () => {
  it('recovers short last chunk without null padding corruption', () => {
    const base64 = 'A'.repeat(3347);
    const chunkSize = 500;
    const k = Math.ceil(base64.length / chunkSize);
    const dataChunks = [];
    for (let i = 0; i < k; i++) {
      dataChunks.push(strToBytes(base64.slice(i * chunkSize, (i + 1) * chunkSize)));
    }

    const parity = ReedSolomon.encode(dataChunks, 3);
    const parityB64 = parity.map(p => Buffer.from(p).toString('base64'));

    const camChunks = new Array(k + 3).fill(null);
    for (let i = 0; i < k - 2; i++) camChunks[i] = base64.slice(i * chunkSize, (i + 1) * chunkSize);
    camChunks[k] = parityB64[0];
    camChunks[k + 1] = parityB64[1];

    const available = [];
    const availableIndices = [];
    for (let i = 0; i < camChunks.length; i++) {
      if (camChunks[i] !== null) {
        availableIndices.push(i);
        let bytes;
        if (i < k) {
          bytes = strToBytes(camChunks[i]);
        } else {
          const binary = Buffer.from(camChunks[i], 'base64').toString('binary');
          bytes = strToBytes(binary);
        }
        available.push(bytes);
      }
    }

    const result = ReedSolomon.decode(available, availableIndices, k);
    assert.ok(result);

    const recovered = [];
    for (let r = 0; r < k; r++) {
      let str = '';
      for (let b = 0; b < result[r].length; b++) str += String.fromCharCode(result[r][b]);
      recovered.push(str.replace(/\0+$/, ''));
    }
    const full = recovered.join('');
    assert.strictEqual(full, base64);
    assert.strictEqual(full.length, 3347);
  });
});

describe('FNV-1a hash', () => {
  it('is deterministic', () => {
    const bytes = Buffer.from('hello world');
    assert.strictEqual(simpleHash(bytes), simpleHash(bytes));
  });

  it('produces 8-char hex string', () => {
    const bytes = Buffer.from('test');
    const hash = simpleHash(bytes);
    assert.match(hash, /^[0-9a-f]{8}$/);
  });

  it('different inputs produce different hashes', () => {
    const h1 = simpleHash(Buffer.from('hello'));
    const h2 = simpleHash(Buffer.from('world'));
    assert.notStrictEqual(h1, h2);
  });

  it('empty input produces valid hash', () => {
    const hash = simpleHash(Buffer.alloc(0));
    assert.match(hash, /^[0-9a-f]{8}$/);
  });
});

describe('Protocol v3 binary framing', () => {
  it('round-trips binary payload without base64 expansion', () => {
    const data = new Uint8Array(1024);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;

    const frames = QrProtocolV3.buildFrames(data, {
      name: 'binary.bin',
      hash: '1234abcd',
      originalSize: data.length,
      chunkBodySize: 500,
      gz: false,
      zip: false,
      rsParity: 0
    });

    assert.strictEqual(frames[0].v, 3);
    assert.ok(frames.length > 1);
    assert.ok(!('text' in frames[0]));
    assert.strictEqual(frames[0].bytes[0], 0x51);
    assert.strictEqual(frames[0].bytes[1], 0x33);
    assert.ok(frames[0].bytes.length < 500 + 64);

    const decoded = {};
    frames.forEach(frame => {
      const parsed = QrProtocolV3.decodeFrame(frame.bytes);
      decoded[parsed.i] = parsed;
    });

    const assembled = QrProtocolV3.assembleData(frames.map(frame => decoded[frame.i].body));
    assert.strictEqual(assembled.meta.name, 'binary.bin');
    assert.strictEqual(assembled.meta.hash, '1234abcd');
    assert.deepStrictEqual(Buffer.from(assembled.bytes), Buffer.from(data));
  });

  it('recovers missing metadata frame through Reed-Solomon parity', () => {
    const data = Buffer.from('hello v3 reed-solomon recovery '.repeat(80));
    const frames = QrProtocolV3.buildFrames(data, {
      name: 'note.txt',
      hash: 'a1b2c3d4',
      originalSize: data.length,
      chunkBodySize: 300,
      gz: false,
      zip: false,
      rsParity: 2
    });

    const parsed = new Array(frames.length).fill(null);
    frames.forEach(frame => {
      if (frame.i !== 0 && frame.i !== 2) parsed[frame.i] = QrProtocolV3.decodeFrame(frame.bytes);
    });

    const recovered = QrProtocolV3.recoverBodies(parsed, frames[0].k);
    assert.ok(recovered);
    const assembled = QrProtocolV3.assembleData(recovered);
    assert.strictEqual(assembled.meta.name, 'note.txt');
    assert.strictEqual(assembled.meta.hash, 'a1b2c3d4');
    assert.deepStrictEqual(Buffer.from(assembled.bytes), Buffer.from(data));
  });
});

describe('bytesToBase64', () => {
  it('round-trips correctly', () => {
    const original = Buffer.from('Hello, World! This is a test of base64 encoding.');
    const b64 = bytesToBase64(original);
    const decoded = Buffer.from(b64, 'base64');
    assert.deepStrictEqual(decoded, original);
  });

  it('round-trips binary data with all byte values', () => {
    const original = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) original[i] = i;
    const b64 = bytesToBase64(original);
    const decoded = Buffer.from(b64, 'base64');
    assert.deepStrictEqual(decoded, original);
  });

  it('round-trips empty input', () => {
    const b64 = bytesToBase64(Buffer.alloc(0));
    assert.strictEqual(b64, '');
  });
});

describe('Chunk protocol v2', () => {
  it('chunk JSON round-trips through JSON.parse', () => {
    const chunk = {
      v: 2, i: 0, n: 17, hash: 'a1b2c3d4', name: 'test.txt',
      gz: 1, zip: 0, rs: 1, k: 7, sz: 19721, t: 'd',
      d: bytesToBase64(Buffer.from('test data'))
    };
    const json = JSON.stringify(chunk);
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.v, 2);
    assert.strictEqual(parsed.i, 0);
    assert.strictEqual(parsed.n, 17);
    assert.strictEqual(parsed.k, 7);
    assert.strictEqual(parsed.t, 'd');
    assert.strictEqual(parsed.rs, 1);
    assert.strictEqual(parsed.sz, 19721);
  });

  it('chunk size stays within QR limits at EC level L', () => {
    const qrCode = eval(fs.readFileSync(path.join(__dirname, '..', 'encoder', 'qrcode.js'), 'utf8') + '; qrcode;');
    for (const ec of ['L', 'M']) {
      for (const chunkSize of [300, 500, 800]) {
        const payload = JSON.stringify({
          v: 2, i: 0, n: 100, hash: '12345678', name: 'x'.repeat(40),
          rs: 1, k: 50, sz: 99999, t: 'd', d: 'A'.repeat(chunkSize)
        });
        try {
          const q = qrCode(0, ec);
          q.addData(payload);
          q.make();
          assert.ok(q.getModuleCount() > 0, `${ec} chunk=${chunkSize} should fit`);
        } catch (e) {
          if (ec === 'M' && chunkSize > 600) continue;
          throw e;
        }
      }
    }
  });
});

describe('Full encode → decode pipeline', () => {
  it('encodes, recovers with RS, and decodes back to original', () => {
    const rawData = Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(50));
    const compressed = zlib.gzipSync(rawData);
    const dataToEncode = compressed.length < rawData.length ? compressed : rawData;
    const base64 = bytesToBase64(dataToEncode);

    const chunkSize = 100;
    const k = Math.ceil(base64.length / chunkSize);
    const dataChunks = [];
    for (let i = 0; i < k; i++) {
      dataChunks.push(strToBytes(base64.slice(i * chunkSize, (i + 1) * chunkSize)));
    }

    const parity = ReedSolomon.encode(dataChunks, 5);

    const camChunks = new Array(k + 5).fill(null);
    for (let i = 0; i < k - 2; i++) camChunks[i] = base64.slice(i * chunkSize, (i + 1) * chunkSize);
    camChunks[k] = Buffer.from(parity[0]).toString('base64');
    camChunks[k + 1] = Buffer.from(parity[1]).toString('base64');

    const available = [];
    const availableIndices = [];
    for (let i = 0; i < camChunks.length; i++) {
      if (camChunks[i] !== null) {
        availableIndices.push(i);
        let bytes;
        if (i < k) {
          bytes = strToBytes(camChunks[i]);
        } else {
          const binary = Buffer.from(camChunks[i], 'base64').toString('binary');
          bytes = strToBytes(binary);
        }
        available.push(bytes);
      }
    }

    const result = ReedSolomon.decode(available, availableIndices, k);
    assert.ok(result);

    const recovered = [];
    for (let r = 0; r < k; r++) {
      let str = '';
      for (let b = 0; b < result[r].length; b++) str += String.fromCharCode(result[r][b]);
      recovered.push(str.replace(/\0+$/, ''));
    }
    const fullB64 = recovered.join('');
    assert.strictEqual(fullB64, base64);

    const decodedBytes = Buffer.from(fullB64, 'base64');
    const decompressed = zlib.gunzipSync(decodedBytes);
    assert.deepStrictEqual(decompressed, rawData);
    assert.strictEqual(simpleHash(decompressed), simpleHash(rawData));
  });
});

describe('Reed-Solomon — recovery does not corrupt present chunks', () => {
  it('only modifies missing chunks, preserves original references', () => {
    const data = [];
    for (let i = 0; i < 7; i++) {
      data.push(strToBytes('data_chunk_' + i + '_' + String.fromCharCode(65 + i).repeat(20)));
    }
    const parity = ReedSolomon.encode(data, 5);

    const avail = [data[0], data[1], data[2], data[3], data[4], parity[0], parity[1]];
    const indices = [0, 1, 2, 3, 4, 7, 8];

    const result = ReedSolomon.decode(avail, indices, 7);
    assert.ok(result);

    for (let i = 0; i < 5; i++) {
      assert.deepStrictEqual(result[i], data[i], `present chunk ${i} was corrupted`);
    }

    assert.deepStrictEqual(result[5], data[5], `recovered chunk 5 mismatch`);
    assert.deepStrictEqual(result[6], data[6], `recovered chunk 6 mismatch`);
  });

  it('result array has exactly k entries', () => {
    const data = [strToBytes('aa'), strToBytes('bb'), strToBytes('cc')];
    const parity = ReedSolomon.encode(data, 3);
    const result = ReedSolomon.decode([data[0], data[1], parity[0]], [0, 1, 3], 3);
    assert.ok(result);
    assert.strictEqual(result.length, 3);
  });
});

describe('getMaxChunkSize accuracy', () => {
  it('returns valid sizes for each EC level', () => {
    const qrCode = eval(fs.readFileSync(path.join(__dirname, '..', 'encoder', 'qrcode.js'), 'utf8') + '; qrcode;');

    for (const ec of ['L', 'M', 'Q', 'H']) {
      let maxSize = 0;
      const sizes = [800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100];
      for (const sz of sizes) {
        const payload = JSON.stringify({
          v: 2, i: 0, n: 999, hash: '12345678', name: 'x'.repeat(40),
          rs: 1, k: 999, sz: 99999, t: 'd', d: 'A'.repeat(sz)
        });
        try {
          const q = qrCode(0, ec);
          q.addData(payload);
          q.make();
          if (sz > maxSize) maxSize = sz;
        } catch (e) { break; }
      }

      assert.ok(maxSize >= 200, `EC ${ec} should support at least 200 byte chunks, got ${maxSize}`);
      assert.ok(maxSize <= 800, `EC ${ec} max should not exceed 800, got ${maxSize}`);
    }
  });

  it('EC H allows fewer bytes than EC L', () => {
    const qrCode = eval(fs.readFileSync(path.join(__dirname, '..', 'encoder', 'qrcode.js'), 'utf8') + '; qrcode;');

    function getMax(ec) {
      const sizes = [1000, 950, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100];
      for (const sz of sizes) {
        const payload = JSON.stringify({
          v: 2, i: 0, n: 999, hash: '12345678', name: 'x'.repeat(40),
          rs: 1, k: 999, sz: 99999, t: 'd', d: 'A'.repeat(sz)
        });
        try {
          const q = qrCode(0, ec);
          q.addData(payload);
          q.make();
        } catch (e) { return sz - 50; }
      }
      return 1000;
    }

    const maxL = getMax('L');
    const maxH = getMax('H');
    assert.ok(maxL >= maxH, `L (${maxL}) should allow >= H (${maxH})`);
  });
});

describe('Server path traversal protection', () => {
  const { resolveSafePath } = require('../server');
  const dir = path.resolve(__dirname, '..');

  it('allows normal files', () => {
    const result = resolveSafePath(dir, '/encoder/index.html');
    assert.ok(result);
    assert.ok(result.endsWith('index.html'));
  });

  it('blocks ../ traversal', () => {
    assert.strictEqual(resolveSafePath(dir, '/../etc/passwd'), null);
  });

  it('blocks URL-encoded ../ traversal', () => {
    assert.strictEqual(resolveSafePath(dir, '/%2e%2e/etc/passwd'), null);
  });

  it('blocks double URL-encoded ../ traversal', () => {
    assert.strictEqual(resolveSafePath(dir, '/%252e%252e/etc/passwd'), null);
  });

  it('blocks mixed URL-encoded traversal', () => {
    assert.strictEqual(resolveSafePath(dir, '/%2e%2e%2fetc%2fpasswd'), null);
  });

  it('resolves root to index.html', () => {
    const result = resolveSafePath(dir, '/');
    assert.ok(result);
    assert.ok(result.endsWith('index.html'));
  });

  it('resolves trailing slash to index.html', () => {
    const result = resolveSafePath(dir, '/encoder/');
    assert.ok(result);
    assert.ok(result.endsWith('index.html'));
  });
});

describe('GIF parser bounds checking', () => {
  const gifParserCode = fs.readFileSync(path.join(__dirname, '..', 'decoder', 'index.html'), 'utf8');
  const match = gifParserCode.match(/var GifParser = \(function\(\) \{([\s\S]*?)return \{ parseFrames: parseFrames \};\n\s*\}\)\(\);/);
  assert.ok(match, 'GifParser not found in decoder');
  const GifParser = vm.runInThisContext('(function() { ' + match[1] + '; return { parseFrames: parseFrames }; })()');

  it('returns null for non-GIF data', () => {
    assert.strictEqual(GifParser.parseFrames(new Uint8Array([0, 1, 2, 3])), null);
  });

  it('handles truncated header gracefully', () => {
    const data = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const result = GifParser.parseFrames(data);
    assert.ok(result);
    assert.strictEqual(result.frames.length, 0);
  });

  it('handles truncated image descriptor gracefully', () => {
    const buf = [
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
      0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x2C,
      0x00, 0x00, 0x00, 0x00
    ];
    const result = GifParser.parseFrames(new Uint8Array(buf));
    assert.ok(result);
    assert.strictEqual(result.frames.length, 0);
  });

  it('handles valid minimal GIF', () => {
    const buf = [
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
      0x01, 0x00, 0x01, 0x00,
      0x80, 0x00, 0x00,
      0x00, 0x00, 0x00,
      0xFF, 0xFF, 0xFF,
      0x2C,
      0x00, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00,
      0x00,
      0x02, 0x02, 0x44, 0x01, 0x00,
      0x3B
    ];
    const result = GifParser.parseFrames(new Uint8Array(buf));
    assert.ok(result);
    assert.strictEqual(result.width, 1);
    assert.strictEqual(result.height, 1);
    assert.strictEqual(result.frames.length, 1);
  });
});
