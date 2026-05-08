var ReedSolomon = (function() {
  var GF = (function() {
    var EXP = new Uint8Array(512);
    var LOG = new Uint8Array(256);
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
    LOG[0] = 255;

    function mul(a, b) {
      if (a === 0 || b === 0) return 0;
      return EXP[LOG[a] + LOG[b]];
    }

    function div(a, b) {
      if (a === 0) return 0;
      if (b === 0) throw new Error('Division by zero');
      return EXP[LOG[a] + 255 - LOG[b]];
    }

    function inv(a) {
      if (a === 0) throw new Error('Cannot invert zero');
      return EXP[255 - LOG[a]];
    }

    return { mul: mul, div: div, inv: inv, EXP: EXP, LOG: LOG };
  })();

  function vandermondeRow(alpha, k) {
    var row = [];
    var val = 1;
    for (var j = 0; j < k; j++) {
      row.push(val);
      val = GF.mul(val, alpha);
    }
    return row;
  }

  function buildMatrix(k, n) {
    var matrix = [];
    for (var i = 0; i < k; i++) {
      var row = new Array(k);
      for (var j = 0; j < k; j++) row[j] = (i === j) ? 1 : 0;
      matrix.push(row);
    }
    for (var i2 = 1; i2 <= n; i2++) {
      matrix.push(vandermondeRow(i2, k));
    }
    return matrix;
  }

  function encodeChunk(dataChunks, parityCount) {
    var k = dataChunks.length;
    if (k === 0) return [];
    var chunkLen = 0;
    for (var i = 0; i < k; i++) {
      if (dataChunks[i].length > chunkLen) chunkLen = dataChunks[i].length;
    }

    var parity = [];

    for (var p = 0; p < parityCount; p++) {
      var row = vandermondeRow(p + 1, k);
      var result = new Uint8Array(chunkLen);
      for (var j = 0; j < k; j++) {
        var coeff = row[j];
        var chunk = dataChunks[j];
        for (var b = 0; b < chunkLen; b++) {
          var val = b < chunk.length ? chunk[b] : 0;
          result[b] ^= GF.mul(coeff, val);
        }
      }
      parity.push(result);
    }
    return parity;
  }

  function decodeChunk(receivedChunks, indices, originalCount) {
    var k = originalCount;
    if (receivedChunks.length >= k) {
      var result = [];
      for (var i = 0; i < k; i++) {
        var idx = indices.indexOf(i);
        result.push(idx >= 0 ? receivedChunks[idx] : null);
      }
      var missing = [];
      for (var m = 0; m < k; m++) {
        if (result[m] === null) missing.push(m);
      }
      if (missing.length === 0) return result;
      return recover(result, indices, receivedChunks, k);
    }

    return recover(null, indices, receivedChunks, k);
  }

  function recover(dataResult, indices, received, k) {
    var available = [];
    var availableData = [];
    for (var i = 0; i < indices.length; i++) {
      available.push(indices[i]);
      availableData.push(received[i]);
    }

    var missing = [];
    if (dataResult) {
      for (var d = 0; d < k; d++) {
        if (dataResult[d] === null) missing.push(d);
      }
    } else {
      for (var d2 = 0; d2 < k; d2++) {
        if (available.indexOf(d2) < 0) missing.push(d2);
      }
    }

    if (missing.length === 0) {
      if (dataResult) return dataResult;
      var res = [];
      for (var r = 0; r < k; r++) res.push(availableData[available.indexOf(r)]);
      return res;
    }

    if (available.length < k) return null;

    var chunkLen = 0;
    for (var c = 0; c < availableData.length; c++) {
      if (availableData[c].length > chunkLen) chunkLen = availableData[c].length;
    }

    var selIndices = available.slice(0, k);
    var selData = availableData.slice(0, k);

    var matrix = [];
    for (var a = 0; a < k; a++) {
      if (selIndices[a] < k) {
        var row = new Array(k);
        for (var j = 0; j < k; j++) row[j] = (selIndices[a] === j) ? 1 : 0;
        matrix.push(row);
      } else {
        matrix.push(vandermondeRow(selIndices[a] - k + 1, k));
      }
    }

    var decodeMatrix = invertMatrix(matrix, k);

    if (!decodeMatrix) return null;

    var result = dataResult || new Array(k);
    for (var mi = 0; mi < missing.length; mi++) {
      var mIdx = missing[mi];
      if (result[mIdx] !== null) continue;
      var recovered = new Uint8Array(chunkLen);
      for (var ai = 0; ai < k; ai++) {
        var coeff = decodeMatrix[mIdx][ai];
        var chunk = selData[ai];
        for (var b = 0; b < chunkLen; b++) {
          var val = b < chunk.length ? chunk[b] : 0;
          recovered[b] ^= GF.mul(coeff, val);
        }
      }
      result[mIdx] = recovered;
    }

    return result;
  }

  function invertMatrix(matrix, k) {
    var n = matrix.length;
    var aug = [];
    for (var i = 0; i < n; i++) {
      var row = matrix[i].slice();
      for (var j = 0; j < n; j++) row.push(i === j ? 1 : 0);
      aug.push(row);
    }

    for (var col = 0; col < n; col++) {
      var pivotRow = -1;
      for (var row2 = col; row2 < n; row2++) {
        if (aug[row2][col] !== 0) { pivotRow = row2; break; }
      }
      if (pivotRow < 0) return null;

      if (pivotRow !== col) {
        var tmp = aug[col];
        aug[col] = aug[pivotRow];
        aug[pivotRow] = tmp;
      }

      var pivotVal = aug[col][col];
      var pivotInv = GF.inv(pivotVal);
      for (var j2 = 0; j2 < 2 * n; j2++) {
        aug[col][j2] = GF.mul(aug[col][j2], pivotInv);
      }

      for (var row3 = 0; row3 < n; row3++) {
        if (row3 === col) continue;
        var factor = aug[row3][col];
        if (factor === 0) continue;
        for (var j3 = 0; j3 < 2 * n; j3++) {
          aug[row3][j3] ^= GF.mul(factor, aug[col][j3]);
        }
      }
    }

    var inverse = [];
    for (var i2 = 0; i2 < n; i2++) {
      inverse.push(aug[i2].slice(n, 2 * n));
    }
    return inverse;
  }

  return { encode: encodeChunk, decode: decodeChunk, buildMatrix: buildMatrix, _GF: GF };
})();
