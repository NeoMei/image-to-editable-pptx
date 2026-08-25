export type ProviderResponseObserver = {
  recordRawResponse(payload: unknown): Promise<void>;
  recordParseError(error: unknown): Promise<void>;
};
