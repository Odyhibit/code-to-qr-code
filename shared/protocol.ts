export interface QrChunk {
  v: number;
  i: number;
  n: number;
  hash: string;
  name: string;
  d: string;
}

export const CHUNK_VERSION = 1;
export const MAX_CHUNK_BYTES = 1200;
