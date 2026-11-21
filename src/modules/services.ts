import { connectionsService } from "@/config/connections";

/**
 * The modules' services (D10). A module's entry is added as it adopts the
 * registry; process-lifetime objects stay in `src/config/`, so the
 * connections service, which holds specs-only seams, is the one wired there.
 * `services()` therefore returns the process-wide instance until a consumer
 * needs a per-request one (D10 follow-up).
 */
export const services = () => ({
  connections: connectionsService,
});
