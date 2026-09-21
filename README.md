# Code to QR Code

Transfer files via animated QR codes. No network, no Bluetooth, no USB — just a screen and a camera.

**[Try it live](https://odyhibit.github.io/code-to-qr-code/)**

## How it works

1. **Encode** — Drop a file or folder. It's compressed, split into chunks, and displayed as animated QR codes.
2. **Transfer** — Point a phone camera at the screen, or export a GIF/video and send it any way you like.
3. **Decode** — Open the decoder on the receiving device. Scan with the camera or upload the GIF/video. The file is reassembled.

Each image frame carries **three independent QR codes** — one per RGB colour channel — tripling data density with no increase in image size.

## Quick start

```bash
npm start
```

Opens an HTTPS server (auto-generated self-signed cert) at `https://localhost:3000`. Your browser will warn about the cert — click **Advanced → Proceed**.

### Without Node

Open `encoder/index.html` or `decoder/index.html` directly in a browser. Camera decoding requires HTTPS so it won't work over `file://`, but GIF/video upload decoding works fine.

## Features

**Encoding:**
- RGB tri-channel encoding: three QR codes per image frame (~3× data density)
- Multi-file and folder support (auto-zipped)
- Gzip compression
- GIF, MP4, and WebM export
- Striped Reed-Solomon erasure coding (12%/25%/38% recovery levels)
- Adjustable QR version and error correction level (L/M/Q/H)

**Decoding:**
- Live camera scan with jsQR, including raw binary QR payloads
- GIF and video upload decoding
- Per-channel adaptive thresholding (Otsu) for robust red/blue recovery
- Progressive preview as chunks arrive
- RS recovery of missing chunks
- ZIP archive browsing

## RGB channel encoding

Each image frame is a single full-colour image that encodes three logical QR codes simultaneously — one in the red channel, one in green, one in blue. Every pixel is one of eight pure colours (the corners of the RGB cube: black, white, red, green, blue, cyan, magenta, yellow).

```
Pixel colour = (R_light, G_light, B_light) where each channel is 0 or 255.
```

**Green** carries the primary (authoritative) channel. Green dominates camera sensor sensitivity (Bayer arrays have 2× green photosites), so it is the most faithfully captured channel and the location for the frame metadata. **Red** and **blue** carry additional data.

Logical chunk numbering maps to image frames as:

```
Frame 0: chunks 0 (green), 1 (red), 2 (blue)
Frame 1: chunks 3 (green), 4 (red), 5 (blue)
…
```

The decoder grid shows one cell per image. Each cell's colour reflects which channels have been successfully decoded, using additive mixing — the first one is red, green, or blue. When there are two colors complete it will be yellow, cyan, or magenta, all three is white.

## Decoding: adaptive channel scanning

For each image frame the decoder:

1. Extracts the **green channel** as grayscale and runs jsQR. On success this also returns the four corner coordinates of the QR code.
2. Uses those coordinates to **crop** the red and blue channel images down to just the QR region before scanning — faster and immune to false positives outside the QR area.
3. Applies **Otsu's thresholding** to the cropped region for red and blue: finds the histogram threshold that maximally separates the dark and light pixel clusters, computes the mean of each cluster, and stretches that range to fill 0–255. This automatically compensates for the lower camera sensitivity in the red and blue channels (the same correction you would do manually with brightness/contrast in an image editor).
4. Falls back to a full-frame scan for red and blue if the green channel fails.

## Project structure

```
index.html              Landing page
encoder/index.html      Encoder (self-contained)
decoder/index.html      Decoder (self-contained)
shared/reedsolomon.js   Reed-Solomon library (source)
server.js               HTTPS dev server
test/test.js            Test suite
```

Encoder and decoder pages bundle all dependencies locally — no CDN, no build step. They work from `file://`, GitHub Pages, or the dev server.

## Chunk protocol (v4)

The encoder emits compact binary QR frames with striped Reed-Solomon recovery.

Every v4 frame has this layout:

```text
2 bytes  magic ("Q4")
1 byte   flags: gzip, zip, Reed-Solomon, parity, monochrome
varint   global transmitted-frame index
varint   total transmitted-frame count
varint   total data-frame count
varint   stripe index
varint   stripe count
varint   shard index within the stripe
varint   data-shard count in the stripe
varint   total-shard count in the stripe
bytes    frame body
```

Stripe 0, shard 0 starts with transfer metadata followed by binary payload bytes:

```text
encoded payload size varint
original file size varint
frame 0 data byte count varint
FNV-1a hash uint32
filename length varint
filename UTF-8 bytes
payload bytes
```

Other data frames contain only binary payload bytes. Data is divided into stripes of at most 32 frames, and each stripe gets its own Reed-Solomon parity. The Low, Balanced, and High settings add up to 4, 8, or 12 repair frames per full stripe; the final short stripe receives proportional parity. This bounds recovery work and prevents losses in one part of a large transfer from consuming redundancy intended for another part. The frames are emitted by shard position across stripes so a short burst of missed camera frames is spread between stripes.

Parity protects complete frame bodies, including the metadata in stripe 0. The decoder can finish as soon as every stripe has at least as many received shards as data shards; it does not need to wait for the particular frames it missed to appear on another loop.

With RGB encoding the total logical frame count is approximately 3× what it would be for a single-channel encode of the same file. The frame index field in each QR payload is the absolute logical frame number, so the protocol layer is unaware of the channel grouping — the decoder simply collects frames by index as they arrive from whichever channel decoded them.

## Testing

```bash
npm test
```

Tests cover GF(256) arithmetic, Reed-Solomon encode/decode, striped v4 recovery and failure boundaries, binary framing, path traversal protection, GIF parser bounds checking, and the full encode→RS→recover→decompress pipeline.

## Camera tips

- **Fast scanning**: lower QR version + EC level L = larger cells, easier to scan
- **Fewer frames**: higher QR version + EC level M = fewer images in the sequence
- **Missed chunks**: use Balanced or High striped recovery for an unreliable camera path
- **Encoder FPS**: monochrome can run up to 25 FPS; raise it until unique-frame throughput stops improving

## Requirements

- Node.js (for dev server and tests)
- Chrome recommended
- OpenSSL optional (server falls back to JS cert generation)

## License

[MIT](https://opensource.org/licenses/MIT)
