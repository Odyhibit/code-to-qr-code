var QrProtocolV3 = (function() {
  var MAGIC_0 = 0x51; // Q
  var MAGIC_1 = 0x33; // 3
  var FLAG_GZIP = 1 << 0;
  var FLAG_ZIP = 1 << 1;
  var FLAG_RS = 1 << 2;
  var FLAG_PARITY = 1 << 3;

  function writeVarint(out, value) {
    value = Number(value);
    while (value >= 0x80) {
      out.push((value & 0x7f) | 0x80);
      value = Math.floor(value / 128);
    }
    out.push(value & 0x7f);
  }

  function readVarint(bytes, pos) {
    var value = 0;
    var shift = 0;
    while (pos < bytes.length) {
      var b = bytes[pos++];
      value += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) return { value: value, pos: pos };
      shift += 7;
      if (shift > 35) throw new Error('varint too long');
    }
    throw new Error('truncated varint');
  }

  function utf8Encode(str) {
    if (typeof TextEncoder !== 'undefined') return Array.prototype.slice.call(new TextEncoder().encode(str));
    var encoded = unescape(encodeURIComponent(str));
    var bytes = [];
    for (var i = 0; i < encoded.length; i++) bytes.push(encoded.charCodeAt(i) & 0xff);
    return bytes;
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(s));
  }

  function stringToBytes(str) {
    var bytes = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
    return bytes;
  }

  function concatParts(parts, totalLength) {
    var out = new Uint8Array(totalLength);
    var offset = 0;
    for (var i = 0; i < parts.length; i++) {
      out.set(parts[i], offset);
      offset += parts[i].length;
    }
    return out;
  }

  function encodeMetadata(meta, firstDataLen) {
    var out = [];
    var nameBytes = utf8Encode(meta.name || 'decoded-file');
    writeVarint(out, meta.encodedSize);
    writeVarint(out, meta.originalSize);
    writeVarint(out, firstDataLen);
    var hashNum = parseInt(meta.hash || '0', 16) >>> 0;
    out.push(hashNum & 0xff, (hashNum >>> 8) & 0xff, (hashNum >>> 16) & 0xff, (hashNum >>> 24) & 0xff);
    writeVarint(out, nameBytes.length);
    for (var i = 0; i < nameBytes.length; i++) out.push(nameBytes[i]);
    return new Uint8Array(out);
  }

  function parseMetadataBody(body) {
    var pos = 0;
    var r = readVarint(body, pos); var encodedSize = r.value; pos = r.pos;
    r = readVarint(body, pos); var originalSize = r.value; pos = r.pos;
    r = readVarint(body, pos); var firstDataLen = r.value; pos = r.pos;
    if (pos + 4 > body.length) throw new Error('truncated hash');
    var hashNum = (body[pos] | (body[pos + 1] << 8) | (body[pos + 2] << 16) | (body[pos + 3] << 24)) >>> 0;
    pos += 4;
    r = readVarint(body, pos); var nameLen = r.value; pos = r.pos;
    if (pos + nameLen > body.length) throw new Error('truncated name');
    var name = utf8Decode(body.subarray(pos, pos + nameLen));
    pos += nameLen;
    var dataEnd = Math.min(body.length, pos + firstDataLen);
    return {
      encodedSize: encodedSize,
      originalSize: originalSize,
      firstDataLen: firstDataLen,
      hash: hashNum.toString(16).padStart(8, '0'),
      name: name,
      data: body.subarray(pos, dataEnd)
    };
  }

  function encodeFrame(frame) {
    var flags = 0;
    if (frame.gz) flags |= FLAG_GZIP;
    if (frame.zip) flags |= FLAG_ZIP;
    if (frame.rs) flags |= FLAG_RS;
    if (frame.parity) flags |= FLAG_PARITY;

    var out = [MAGIC_0, MAGIC_1, flags];
    writeVarint(out, frame.i);
    writeVarint(out, frame.n);
    writeVarint(out, frame.k);
    for (var b = 0; b < frame.body.length; b++) out.push(frame.body[b]);
    return new Uint8Array(out);
  }

  function decodeFrame(input) {
    var bytes = input instanceof Uint8Array ? input : stringToBytes(input || '');
    if (bytes.length < 3 || bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1) return null;
    var flags = bytes[2];
    var pos = 3;
    var r = readVarint(bytes, pos); var i = r.value; pos = r.pos;
    r = readVarint(bytes, pos); var n = r.value; pos = r.pos;
    r = readVarint(bytes, pos); var k = r.value; pos = r.pos;
    var body = bytes.subarray(pos);
    var frame = {
      v: 3,
      i: i,
      n: n,
      k: k,
      gz: (flags & FLAG_GZIP) !== 0,
      zip: (flags & FLAG_ZIP) !== 0,
      rs: (flags & FLAG_RS) !== 0,
      parity: (flags & FLAG_PARITY) !== 0,
      body: body
    };
    if (i === 0 && !frame.parity) frame.meta = parseMetadataBody(body);
    return frame;
  }

  function makeDataBodies(dataBytes, meta, chunkBodySize) {
    var firstDataLen = 0;
    var metadata = encodeMetadata(meta, firstDataLen);
    while (true) {
      firstDataLen = Math.max(0, chunkBodySize - metadata.length);
      var next = encodeMetadata(meta, Math.min(firstDataLen, dataBytes.length));
      if (next.length === metadata.length) {
        metadata = next;
        firstDataLen = Math.min(firstDataLen, dataBytes.length);
        break;
      }
      metadata = next;
    }

    var bodies = [];
    var firstData = dataBytes.subarray(0, firstDataLen);
    bodies.push(concatParts([metadata, firstData], metadata.length + firstData.length));
    for (var offset = firstDataLen; offset < dataBytes.length; offset += chunkBodySize) {
      bodies.push(dataBytes.subarray(offset, Math.min(offset + chunkBodySize, dataBytes.length)));
    }
    return bodies;
  }

  function buildFrames(dataBytes, options) {
    var meta = {
      name: options.name,
      hash: options.hash,
      originalSize: options.originalSize,
      encodedSize: dataBytes.length
    };
    var dataBodies = makeDataBodies(dataBytes, meta, options.chunkBodySize);
    var parityBodies = [];
    if (options.rsParity > 0 && dataBodies.length > 0) {
      parityBodies = ReedSolomon.encode(dataBodies, options.rsParity);
    }
    var total = dataBodies.length + parityBodies.length;
    var frames = [];
    for (var i = 0; i < dataBodies.length; i++) {
      frames.push({ v: 3, i: i, n: total, k: dataBodies.length, gz: options.gz, zip: options.zip, rs: parityBodies.length > 0, parity: false, body: dataBodies[i] });
    }
    for (var p = 0; p < parityBodies.length; p++) {
      frames.push({ v: 3, i: dataBodies.length + p, n: total, k: dataBodies.length, gz: options.gz, zip: options.zip, rs: true, parity: true, body: parityBodies[p] });
    }
    return frames.map(function(frame) {
      var bytes = encodeFrame(frame);
      frame.bytes = bytes;
      if (frame.i === 0 && !frame.parity) frame.meta = parseMetadataBody(frame.body);
      return frame;
    });
  }

  function recoverBodies(frames, k) {
    var available = [];
    var indices = [];
    for (var i = 0; i < frames.length; i++) {
      if (frames[i] !== null && frames[i] !== undefined) {
        available.push(frames[i].body);
        indices.push(i);
      }
    }
    if (available.length < k) return null;
    return ReedSolomon.decode(available, indices, k);
  }

  function assembleData(dataBodies) {
    var meta = parseMetadataBody(dataBodies[0]);
    var parts = [meta.data];
    var total = meta.data.length;
    for (var i = 1; i < dataBodies.length; i++) {
      parts.push(dataBodies[i]);
      total += dataBodies[i].length;
    }
    var joined = concatParts(parts, total);
    return {
      meta: meta,
      bytes: joined.subarray(0, meta.encodedSize)
    };
  }

  return {
    FLAG_GZIP: FLAG_GZIP,
    FLAG_ZIP: FLAG_ZIP,
    FLAG_RS: FLAG_RS,
    FLAG_PARITY: FLAG_PARITY,
    stringToBytes: stringToBytes,
    encodeFrame: encodeFrame,
    decodeFrame: decodeFrame,
    buildFrames: buildFrames,
    recoverBodies: recoverBodies,
    assembleData: assembleData,
    parseMetadataBody: parseMetadataBody
  };
})();
