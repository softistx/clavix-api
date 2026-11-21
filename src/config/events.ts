import { createEventBus } from "@/events/bus";
import { authRecorder } from "@/modules/audit/audit.recorder";
import { authEventsService } from "./audit";
import { reportError } from "./runtime";

/** How many events a subscriber failed to handle since the process started (D13); read by telemetry when it is wired. */
export const eventFailures = { count: 0 };

/**
 * The Clavix event bus (D12): the sign-in log is its first subscriber;
 * webhooks and telemetry join it later. A failed write is logged and counted,
 * never raised to the sign-in (D13).
 */
export const eventBus = createEventBus({
  onFailure: (error, event) => {
    eventFailures.count += 1;
    reportError(
      `events: ${event.kind} event not recorded (${eventFailures.count} failed since start)`,
      error,
    );
  },
});

eventBus.subscribe(authRecorder(authEventsService));
