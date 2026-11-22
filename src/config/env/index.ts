import { defineEnv } from "@softistx/alxia-env";
import { coreEnv } from "./core";
import { limitsEnv } from "./limits";
import { mediaEnv } from "./media";
import { webhooksEnv } from "./webhooks";

export { DEV_KEYS_MASTER_KEY } from "./shared";

// Read once, at import: a malformed variable stops the process before it
// listens. `.env.example` lists them; Bun loads `.env` on every command.
// One file per area: core.ts, limits.ts, media.ts, webhooks.ts; shared.ts holds the
// helpers and schemas they use.
export const env = defineEnv({
  ...coreEnv(),
  ...limitsEnv,
  ...mediaEnv(),
  ...webhooksEnv(),
});
