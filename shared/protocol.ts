export interface QrFrameV3 {
  v: 3;
  i: number;
  n: number;
  k: number;
  gz: boolean;
  zip: boolean;
  rs: boolean;
  parity: boolean;
  body: Uint8Array;
}

export const CHUNK_VERSION = 3;
export const MAX_CHUNK_BYTES = 1200;
