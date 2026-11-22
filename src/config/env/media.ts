import { z } from "zod";
import { optionalOutsideProduction } from "./shared";

// The private bucket of the pictures (S3 or compatible, never opened to the
// browser). Required in production; elsewhere left out, the picture routes
// answer 503 and erasing a user or purging a tenant has no object to remove.
export const mediaEnv = () => {
  const text = optionalOutsideProduction(z.string().min(1));
  return {
    CLAVIX_MEDIA_S3_ENDPOINT: optionalOutsideProduction(z.url()),
    CLAVIX_MEDIA_S3_BUCKET: text,
    CLAVIX_MEDIA_S3_ACCESS_KEY_ID: text,
    CLAVIX_MEDIA_S3_SECRET_ACCESS_KEY: text,
    CLAVIX_MEDIA_S3_REGION: z.string().min(1).default("us-east-1"),
  };
};
