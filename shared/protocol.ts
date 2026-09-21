export interface QrFrameV4 {
  v: 4;
  i: number;
  n: number;
  k: number;
  gz: boolean;
  zip: boolean;
  rs: boolean;
  parity: boolean;
  mono?: boolean;
  s: number;
  g: number;
  j: number;
  d: number;
  t: number;
  body: Uint8Array;
}

export const CHUNK_VERSION = 4;
export const MAX_CHUNK_BYTES = 1200;
