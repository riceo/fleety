import type { NormPosition } from '../types.js';

export interface AdsbProvider {
  readonly name: string;
  // One call for the whole tracked set; returns only aircraft currently known
  // to the provider. Throws on transport/HTTP errors (the poller handles backoff).
  fetchPositions(hexes: string[]): Promise<NormPosition[]>;
}

export class ProviderHttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
