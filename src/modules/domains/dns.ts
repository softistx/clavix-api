import { Resolver } from "node:dns/promises";

/** What a TXT lookup found. */
export type TxtAnswer =
  | { kind: "records"; values: string[] }
  /** NXDOMAIN or no TXT data at the name. */
  | { kind: "none" }
  /** The resolver could not answer (timeout, SERVFAIL, refused): nothing is known. */
  | { kind: "failed" };

/**
 * The DNS port of the domain verification. Injected, so specs never touch the
 * network; `systemTxtResolver` is the real one.
 */
export interface TxtResolver {
  resolveTxt(name: string): Promise<TxtAnswer>;
}

const NOT_FOUND = new Set(["ENOTFOUND", "ENODATA"]);

/** Node's resolver with a short timeout. A record split in chunks is joined (RFC 1035). */
export function systemTxtResolver(
  servers?: string[],
  timeoutMs = 4_000,
): TxtResolver {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 2 });
  if (servers !== undefined && servers.length > 0) resolver.setServers(servers);
  return {
    async resolveTxt(name) {
      try {
        const records = await resolver.resolveTxt(name);
        return { kind: "records", values: records.map((r) => r.join("")) };
      } catch (error) {
        const code = (error as { code?: string }).code;
        return code !== undefined && NOT_FOUND.has(code)
          ? { kind: "none" }
          : { kind: "failed" };
      }
    },
  };
}
