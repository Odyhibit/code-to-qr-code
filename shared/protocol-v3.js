var QrProtocolV3 = (function() {
  var MAGIC_0 = 0x51; // Q
  var MAGIC_1 = 0x33; // 3
  var MAGIC_1_V4 = 0x34; // 4
  var STRIPE_DATA_SHARDS = 32;
  var FLAG_GZIP = 1 << 0;
  var FLAG_ZIP = 1 << 1;
  var FLAG_RS = 1 << 2;
  var FLAG_PARITY = 1 << 3;
  var FLAG_MONO = 1 << 4;

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
    if (frame.mono) flags |= FLAG_MONO;

    var out = [MAGIC_0, frame.v === 4 ? MAGIC_1_V4 : MAGIC_1, flags];
    writeVarint(out, frame.i);
    writeVarint(out, frame.n);
    writeVarint(out, frame.k);
    if (frame.v === 4) {
      writeVarint(out, frame.s);
      writeVarint(out, frame.g);
      writeVarint(out, frame.j);
      writeVarint(out, frame.d);
      writeVarint(out, frame.t);
    }
    for (var b = 0; b < frame.body.length; b++) out.push(frame.body[b]);
    return new Uint8Array(out);
  }

  function decodeFrame(input) {
    var bytes = input instanceof Uint8Array ? input : stringToBytes(input || '');
    if (bytes.length < 3 || bytes[0] !== MAGIC_0 ||
        (bytes[1] !== MAGIC_1 && bytes[1] !== MAGIC_1_V4)) return null;
    var version = bytes[1] === MAGIC_1_V4 ? 4 : 3;
    var flags = bytes[2];
    var pos = 3;
    var r = readVarint(bytes, pos); var i = r.value; pos = r.pos;
    r = readVarint(bytes, pos); var n = r.value; pos = r.pos;
    r = readVarint(bytes, pos); var k = r.value; pos = r.pos;
    var s = 0, g = 1, j = i, d = k, t = n;
    if (version === 4) {
      r = readVarint(bytes, pos); s = r.value; pos = r.pos;
      r = readVarint(bytes, pos); g = r.value; pos = r.pos;
      r = readVarint(bytes, pos); j = r.value; pos = r.pos;
      r = readVarint(bytes, pos); d = r.value; pos = r.pos;
      r = readVarint(bytes, pos); t = r.value; pos = r.pos;
    }
    var body = bytes.subarray(pos);
    var frame = {
      v: version,
      i: i,
      n: n,
      k: k,
      gz: (flags & FLAG_GZIP) !== 0,
      zip: (flags & FLAG_ZIP) !== 0,
      rs: (flags & FLAG_RS) !== 0,
      parity: (flags & FLAG_PARITY) !== 0,
      mono: (flags & FLAG_MONO) !== 0,
      body: body
    };
    if (version === 4) {
      frame.s = s; frame.g = g; frame.j = j; frame.d = d; frame.t = t;
    }
    if ((version === 3 && i === 0 || version === 4 && s === 0 && j === 0) && !frame.parity) {
      frame.meta = parseMetadataBody(body);
    }
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
    var stripes = [];
    for (var start = 0; start < dataBodies.length; start += STRIPE_DATA_SHARDS) {
      var stripeData = dataBodies.slice(start, Math.min(start + STRIPE_DATA_SHARDS, dataBodies.length));
      var parityCount = options.rsParity > 0
        ? Math.max(1, Math.ceil(stripeData.length * options.rsParity / STRIPE_DATA_SHARDS)) : 0;
      stripes.push({ data: stripeData, parity: ReedSolomon.encode(stripeData, parityCount) });
    }
    var total = 0;
    for (var sc = 0; sc < stripes.length; sc++) total += stripes[sc].data.length + stripes[sc].parity.length;
    var frames = [];
    var maxShards = STRIPE_DATA_SHARDS + (options.rsParity || 0);
    for (var shard = 0; shard < maxShards; shard++) {
      for (var stripeIndex = 0; stripeIndex < stripes.length; stripeIndex++) {
        var stripe = stripes[stripeIndex];
        var body = shard < stripe.data.length ? stripe.data[shard] : stripe.parity[shard - stripe.data.length];
        if (!body) continue;
        frames.push({
          v: 4, i: frames.length, n: total, k: dataBodies.length,
          s: stripeIndex, g: stripes.length, j: shard,
          d: stripe.data.length, t: stripe.data.length + stripe.parity.length,
          gz: options.gz, zip: options.zip, rs: stripe.parity.length > 0,
          parity: shard >= stripe.data.length, mono: options.mono === true, body: body
        });
      }
    }
    return frames.map(function(frame) {
      var bytes = encodeFrame(frame);
      frame.bytes = bytes;
      if (frame.s === 0 && frame.j === 0 && !frame.parity) frame.meta = parseMetadataBody(frame.body);
      return frame;
    });
  }

  function recoverStripedBodies(frames) {
    var stripes = {};
    var stripeCount = null;
    for (var key in frames) {
      var frame = frames[key];
      if (!frame || frame.v !== 4) continue;
      stripeCount = frame.g;
      if (!stripes[frame.s]) stripes[frame.s] = { d: frame.d, shards: [] };
      stripes[frame.s].shards[frame.j] = frame.body;
    }
    if (stripeCount === null) return null;
    var dataBodies = [];
    var recovered = false;
    for (var s = 0; s < stripeCount; s++) {
      var stripe = stripes[s];
      if (!stripe) return null;
      var available = [], indices = [], hasAllData = true;
      for (var j = 0; j < stripe.shards.length; j++) {
        if (stripe.shards[j]) { available.push(stripe.shards[j]); indices.push(j); }
      }
      for (var d = 0; d < stripe.d; d++) if (!stripe.shards[d]) hasAllData = false;
      if (available.length < stripe.d) return null;
      var decoded;
      if (hasAllData) decoded = stripe.shards.slice(0, stripe.d);
      else {
        decoded = ReedSolomon.decode(available, indices, stripe.d);
        if (!decoded) return null;
        recovered = true;
      }
      for (var b = 0; b < decoded.length; b++) dataBodies.push(decoded[b]);
    }
    return { bodies: dataBodies, recovered: recovered };
  }

  function canRecoverStriped(frames) {
    var stripes = {};
    var stripeCount = null;
    for (var key in frames) {
      var frame = frames[key];
      if (!frame || frame.v !== 4) continue;
      stripeCount = frame.g;
      if (!stripes[frame.s]) stripes[frame.s] = { d: frame.d, count: 0 };
      stripes[frame.s].count++;
    }
    if (stripeCount === null) return false;
    for (var s = 0; s < stripeCount; s++) {
      if (!stripes[s] || stripes[s].count < stripes[s].d) return false;
    }
    return true;
  }

  function assembleStripedData(frames) {
    var recovered = recoverStripedBodies(frames);
    if (!recovered) return null;
    var assembled = assembleData(recovered.bodies);
    assembled.recovered = recovered.recovered;
    return assembled;
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
    FLAG_MONO: FLAG_MONO,
    stringToBytes: stringToBytes,
    encodeFrame: encodeFrame,
    decodeFrame: decodeFrame,
    buildFrames: buildFrames,
    recoverBodies: recoverBodies,
    recoverStripedBodies: recoverStripedBodies,
    canRecoverStriped: canRecoverStriped,
    assembleStripedData: assembleStripedData,
    assembleData: assembleData,
    parseMetadataBody: parseMetadataBody
  };
})();
