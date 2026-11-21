import { readiness } from "@/modules/health";
import { mongo } from "./db";
import { redis } from "./redis";

const appRedis = redis;

/** `GET /readyz` over the real Mongo and Redis. */
export const readyz = () =>
  readiness({
    mongo: async () => {
      await mongo.db.command({ ping: 1 });
      return true;
    },
    redis:
      appRedis === undefined
        ? null
        : async () => (await appRedis.ping({ timeoutMs: 1_500 })).default.ok,
  });
