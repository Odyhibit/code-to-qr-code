/* Live-camera QR decoding worker. Camera frames are disposable: the main
 * thread sends work only to an idle worker and drops captures while the pool
 * is full, keeping latency bounded instead of building a stale-frame queue. */
var workerStartupError = null;
try {
  importScripts('jsQR.min.js');
  if (typeof self.jsQR !== 'function') throw new Error('jsQR did not initialize in the worker');
} catch (error) {
  workerStartupError = error && error.message ? error.message : String(error);
}
var decodeQr = self.jsQR;

function extractChannelImageData(imageData, channel) {
  var source = imageData.data;
  var count = imageData.width * imageData.height;
  var out = new Uint8ClampedArray(count * 4);
  for (var i = 0; i < count; i++) {
    var value = source[i * 4 + channel];
    out[i * 4] = value;
    out[i * 4 + 1] = value;
    out[i * 4 + 2] = value;
    out[i * 4 + 3] = 255;
  }
  return { data: out, width: imageData.width, height: imageData.height };
}

function cropToLocation(imageData, location, padding) {
  if (!location) return imageData;
  var points = [location.topLeftCorner, location.topRightCorner,
    location.bottomRightCorner, location.bottomLeftCorner];
  var minX = imageData.width, minY = imageData.height, maxX = 0, maxY = 0;
  for (var i = 0; i < points.length; i++) {
    minX = Math.min(minX, points[i].x);
    minY = Math.min(minY, points[i].y);
    maxX = Math.max(maxX, points[i].x);
    maxY = Math.max(maxY, points[i].y);
  }
  minX = Math.max(0, Math.floor(minX - padding));
  minY = Math.max(0, Math.floor(minY - padding));
  maxX = Math.min(imageData.width, Math.ceil(maxX + padding));
  maxY = Math.min(imageData.height, Math.ceil(maxY + padding));
  var width = Math.max(1, maxX - minX);
  var height = Math.max(1, maxY - minY);
  var out = new Uint8ClampedArray(width * height * 4);
  for (var y = 0; y < height; y++) {
    var start = ((minY + y) * imageData.width + minX) * 4;
    out.set(imageData.data.subarray(start, start + width * 4), y * width * 4);
  }
  return { data: out, width: width, height: height };
}

function otsuNormalize(imageData, channel) {
  var data = imageData.data;
  var count = imageData.width * imageData.height;
  var histogram = new Uint32Array(256);
  for (var i = 0; i < count; i++) histogram[data[i * 4 + channel]]++;

  var sumAll = 0;
  for (var value = 0; value < 256; value++) sumAll += value * histogram[value];
  var sumBackground = 0, backgroundWeight = 0, maxVariance = 0, threshold = 128;
  for (var t = 0; t < 256; t++) {
    backgroundWeight += histogram[t];
    if (backgroundWeight === 0) continue;
    var foregroundWeight = count - backgroundWeight;
    if (foregroundWeight === 0) break;
    sumBackground += t * histogram[t];
    var backgroundMean = sumBackground / backgroundWeight;
    var foregroundMean = (sumAll - sumBackground) / foregroundWeight;
    var variance = backgroundWeight * foregroundWeight *
      (backgroundMean - foregroundMean) * (backgroundMean - foregroundMean);
    if (variance > maxVariance) { maxVariance = variance; threshold = t; }
  }

  var darkSum = 0, darkCount = 0, lightSum = 0, lightCount = 0;
  for (var v = 0; v < 256; v++) {
    if (v <= threshold) { darkSum += v * histogram[v]; darkCount += histogram[v]; }
    else { lightSum += v * histogram[v]; lightCount += histogram[v]; }
  }
  var darkCenter = darkCount ? darkSum / darkCount : 0;
  var lightCenter = lightCount ? lightSum / lightCount : 255;
  var range = lightCenter - darkCenter || 1;
  var out = new Uint8ClampedArray(count * 4);
  for (var p = 0; p < count; p++) {
    var normalized = Math.min(255, Math.max(0,
      Math.round((data[p * 4 + channel] - darkCenter) * 255 / range)));
    out[p * 4] = normalized;
    out[p * 4 + 1] = normalized;
    out[p * 4 + 2] = normalized;
    out[p * 4 + 3] = 255;
  }
  return { data: out, width: imageData.width, height: imageData.height };
}

function distance(a, b) {
  var dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function rectifyChannelToLocation(imageData, channel, location) {
  if (!location) return null;
  var topLeft = location.topLeftCorner, topRight = location.topRightCorner;
  var bottomRight = location.bottomRightCorner, bottomLeft = location.bottomLeftCorner;
  var edge = Math.max(distance(topLeft, topRight), distance(topRight, bottomRight),
    distance(bottomRight, bottomLeft), distance(bottomLeft, topLeft));
  var size = Math.max(120, Math.min(700, Math.round(edge)));
  if (!isFinite(size) || size <= 0) return null;

  var source = imageData.data;
  var out = new Uint8ClampedArray(size * size * 4);
  for (var y = 0; y < size; y++) {
    var vertical = size === 1 ? 0 : y / (size - 1);
    for (var x = 0; x < size; x++) {
      var horizontal = size === 1 ? 0 : x / (size - 1);
      var sx = (1 - horizontal) * (1 - vertical) * topLeft.x +
        horizontal * (1 - vertical) * topRight.x + horizontal * vertical * bottomRight.x +
        (1 - horizontal) * vertical * bottomLeft.x;
      var sy = (1 - horizontal) * (1 - vertical) * topLeft.y +
        horizontal * (1 - vertical) * topRight.y + horizontal * vertical * bottomRight.y +
        (1 - horizontal) * vertical * bottomLeft.y;
      sx = Math.max(0, Math.min(imageData.width - 1, Math.round(sx)));
      sy = Math.max(0, Math.min(imageData.height - 1, Math.round(sy)));
      var sourceIndex = (sy * imageData.width + sx) * 4;
      var targetIndex = (y * size + x) * 4;
      var channelValue = source[sourceIndex + channel];
      out[targetIndex] = channelValue;
      out[targetIndex + 1] = channelValue;
      out[targetIndex + 2] = channelValue;
      out[targetIndex + 3] = 255;
    }
  }
  return otsuNormalize({ data: out, width: size, height: size }, 0);
}

function scanChannelWithHint(imageData, channel, location) {
  var rectified = rectifyChannelToLocation(imageData, channel, location);
  if (rectified) {
    var rectifiedCode = decodeQr(rectified.data, rectified.width, rectified.height,
      { inversionAttempts: 'attemptBoth' });
    if (rectifiedCode) return rectifiedCode;
  }
  var crop = cropToLocation(imageData, location, 20);
  var normalized = otsuNormalize(crop, channel);
  return decodeQr(normalized.data, normalized.width, normalized.height,
    { inversionAttempts: 'attemptBoth' });
}

function compactResult(code, channel) {
  if (!code || (!code.data && !code.binaryData)) return null;
  return { data: code.data || '', binaryData: code.binaryData || null, channel: channel };
}

function scanFrame(imageData, mode, knownMono) {
  var results = [];
  if (mode !== 'color') {
    var direct = compactResult(decodeQr(imageData.data, imageData.width, imageData.height,
      { inversionAttempts: 'attemptBoth' }), 'direct');
    if (direct) results.push(direct);
  }
  if (knownMono) return results;

  var greenImage = extractChannelImageData(imageData, 1);
  var greenCode = decodeQr(greenImage.data, greenImage.width, greenImage.height,
    { inversionAttempts: 'attemptBoth' });
  var green = compactResult(greenCode, 'green');
  if (green) results.push(green);
  var location = greenCode && greenCode.location;

  var channels = [{ index: 0, name: 'red' }, { index: 2, name: 'blue' }];
  for (var i = 0; i < channels.length; i++) {
    var item = channels[i];
    var code;
    if (location) {
      code = scanChannelWithHint(imageData, item.index, location);
    } else {
      var channelImage = extractChannelImageData(imageData, item.index);
      code = decodeQr(channelImage.data, channelImage.width, channelImage.height,
        { inversionAttempts: 'attemptBoth' });
    }
    var result = compactResult(code, item.name);
    if (result) results.push(result);
  }
  return results;
}

self.onmessage = function(event) {
  var message = event.data;
  try {
    if (workerStartupError) throw new Error(workerStartupError);
    var imageData = {
      data: new Uint8ClampedArray(message.buffer),
      width: message.width,
      height: message.height
    };
    self.postMessage({
      id: message.id,
      generation: message.generation,
      results: scanFrame(imageData, message.mode, message.knownMono)
    });
  } catch (error) {
    self.postMessage({
      id: message.id,
      generation: message.generation,
      results: [],
      error: error && error.message ? error.message : String(error)
    });
  }
};

self.postMessage({ ready: !workerStartupError, startupError: workerStartupError });
