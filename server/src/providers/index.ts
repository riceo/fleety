import type { NormPosition, NormPresence } from '../types.js';

export interface ProviderStates {
  positions: NormPosition[];
  presences: NormPresence[];
  // Set when some (but not all) of a multi-request batch failed — the caller
  // keeps the salvaged data but should still back the provider off.
  partial?: boolean;
}

export interface AdsbProvider {
  readonly name: string;
  // One call for the whole tracked set; returns positions plus position-less
  // transponder sightings ("awake"). Throws on transport/HTTP errors (the
  // poller handles backoff and failover).
  fetchStates(hexes: string[]): Promise<ProviderStates>;
}

export class ProviderHttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
