import { defineEnv } from "@alxia/env";
import { z } from "zod";

// Read once, at import: a malformed variable stops the process before it
// listens. `.env.example` lists them; Bun loads `.env` on every command.
// MongoDB and Redis variables arrive with the slices that connect to them.
export const env = defineEnv({
  PORT: z.coerce.number().default(3000),
});
