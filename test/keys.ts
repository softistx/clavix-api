import {
  createKeyGenerations,
  KeysService,
  type TenantKeys,
} from "@/modules/keys";

/** A `KeysService` over some tenant keys, with a fixed clock and a silent log, for specs. */
export const keysServiceOf = (
  keys: TenantKeys,
  now: () => Date = () => new Date(),
  log: (message: string) => void = () => {},
) => new KeysService({ keys, generations: createKeyGenerations(), now, log });
