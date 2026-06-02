# Code to QR Code

Transfer files via animated QR codes. No network, no Bluetooth, no USB — just a screen and a camera.

**[Try it live](https://sdcvo.github.io/code-to-qr-code/)**

## How it works

1. **Encode** — Drop a file or folder. It's compressed, split into chunks, and displayed as animated QR codes.
2. **Transfer** — Point a phone camera at the screen, or export a GIF/video and send it any way you like.
3. **Decode** — Open the decoder on the receiving device. Scan with the camera or upload the GIF/video. The file is reassembled.

## Quick start

```bash
npm start
```

Opens an HTTPS server (auto-generated self-signed cert) at `https://localhost:3000`. Your browser will warn about the cert — click **Advanced → Proceed**.

### Without Node

Open `encoder/index.html` or `decoder/index.html` directly in a browser. Camera decoding requires HTTPS so it won't work over `file://`, but GIF/video upload decoding works fine.

## Features

**Encoding:**
- Multi-file and folder support (auto-zipped)
- Gzip compression
- GIF, MP4, and WebM export
- Reed-Solomon erasure coding (+2/+5/+10 parity chunks)
- Adjustable QR version and QR error correction level (L/M/Q/H)

**Decoding:**
- Live camera scan with jsQR, including raw binary QR payloads
- GIF and video upload decoding
- Progressive preview as chunks arrive
- RS recovery of missing chunks
- ZIP archive browsing

## Project structure

```
index.html              Landing page
encoder/index.html      Encoder (self-contained)
decoder/index.html      Decoder (self-contained)
shared/reedsolomon.js   Reed-Solomon library (source)
server.js               HTTPS dev server
test/test.js            Test suite (43 tests)
```

Encoder and decoder pages bundle all dependencies locally — no CDN, no build step. They work from `file://`, GitHub Pages, or the dev server.

## Chunk protocol (v3)

The encoder emits compact binary QR frames. The decoder still accepts the older JSON v1/v2 frames for compatibility.

Frame layout:

```text
"Q3" magic
flags byte: gzip, zip, Reed-Solomon, parity
frame index varint
total frame count varint
data frame count varint
binary frame body
```

Frame 0's body starts with transfer metadata, then binary payload bytes:

```text
encoded payload size varint
original file size varint
frame 0 data byte count varint
FNV-1a hash uint32
filename length varint
filename UTF-8 bytes
payload bytes
```

Other data frames contain only binary payload bytes. Parity frames contain Reed-Solomon parity bytes. Reed-Solomon protects data frame bodies, including frame 0 metadata, so a missing metadata frame can be recovered from parity.

## Testing

```bash
npm test
```

45 tests covering GF(256) arithmetic, Reed-Solomon encode/decode, recovery scenarios, v3 binary framing, path traversal protection, GIF parser bounds checking, and the full encode→RS→recover→decompress pipeline.

## Camera tips

- **Fast scanning**: lower QR version + EC level L = larger cells, easier to scan
- **Fewer frames**: higher QR version + EC level M = fewer QR codes in the sequence
- **Missed chunks**: add +2 or +5 RS parity to recover from dropped frames
- **Encoder FPS**: start at 3–6 FPS and adjust

## Requirements

- Node.js (for dev server and tests)
- Chrome recommended
- OpenSSL optional (server falls back to JS cert generation)

## License

[MIT](https://opensource.org/licenses/MIT)
