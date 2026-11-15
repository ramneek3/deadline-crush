// All deadline decisions use this server-side clock. The client's clock is never consulted.
let override: (() => number) | null = null;
export const now = (): Date => new Date(override ? override() : Date.now());
export const setClock = (fn: (() => number) | null) => {
  override = fn;
};
