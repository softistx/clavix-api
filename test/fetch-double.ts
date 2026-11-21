/** A `fetch` double: the handler under the whole `typeof fetch` (Bun's adds `preconnect`). */
export const fetchDouble = (
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch => Object.assign(handler, { preconnect: () => {} });
