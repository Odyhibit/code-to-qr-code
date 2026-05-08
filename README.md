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
- Adjustable chunk size (100–800 B) and QR error correction level (L/M/Q/H)

**Decoding:**
- Live camera scan with native `BarcodeDetector` (hardware-accelerated) + jsQR fallback
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

## Chunk protocol (v2)

Each QR code contains a JSON chunk:

```json
{
  "v": 2, "i": 0, "n": 17,
  "hash": "a1b2c3d4", "name": "file.txt",
  "gz": 1, "zip": 0, "rs": 1, "k": 7, "sz": 19721,
  "t": "d", "d": "base64data..."
}
```

| Field | Description |
|-------|-------------|
| `v`   | Protocol version (2) |
| `i`   | Chunk index (0-based) |
| `n`   | Total chunks (data + parity) |
| `hash`| FNV-1a hash of original file |
| `name`| File name |
| `gz`  | 1 if gzip-compressed |
| `zip` | 1 if zip archive |
| `rs`  | 1 if Reed-Solomon enabled |
| `k`   | Data chunk count (for RS) |
| `sz`  | Original file size in bytes |
| `t`   | `d` = data, `p` = parity |
| `d`   | Base64 payload |

## Testing

```bash
npm test
```

43 tests covering GF(256) arithmetic, Reed-Solomon encode/decode, recovery scenarios, path traversal protection, GIF parser bounds checking, and the full encode→RS→recover→decompress pipeline.

## Camera tips

- **Fast scanning**: chunk size 300 + EC level L = larger cells, easier to scan
- **Fewer frames**: chunk size 800 + EC level M = fewer QR codes in the sequence
- **Missed chunks**: add +2 or +5 RS parity to recover from dropped frames
- **Encoder FPS**: start at 3–6 FPS and adjust

## Requirements

- Node.js (for dev server and tests)
- Chrome recommended (BarcodeDetector API support)
- OpenSSL optional (server falls back to JS cert generation)

## License

[MIT](https://opensource.org/licenses/MIT)
