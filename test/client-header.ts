import { CLIENT_HEADER } from "@/http/csrf";

/** The header every spec request to `/graphql` and `/console/graphql` sends, as clavix-ui does. */
export const clientHeaders = { [CLIENT_HEADER]: "clavix-spec" } as const;
