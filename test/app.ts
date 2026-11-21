import { type AppOptions, createApp } from "@/app";
import { appPorts } from "@/config/app-ports";

/** `createApp` with the app's own ports bound; a spec overrides the ones it tests. */
export const createTestApp = (options: Partial<AppOptions> = {}) =>
  createApp({ ...appPorts, ...options });
