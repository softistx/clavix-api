import type { Clock } from "@softistx/janus";

/**
 * The process's clock and logger, bound once here and passed down: no service,
 * worker or job defaults its own (AGENTS.md: ports and clocks are passed
 * explicitly). A spec passes a fixed clock and a recording logger instead.
 */
export const clock = (): Date => new Date();

/** Milliseconds since the epoch, for the services that count in numbers. */
export const clockMs = (): number => Date.now();

/** The warning logger of the long-lived objects (a failure is logged, never thrown). */
export const warn = (message: string): void => console.warn(message);

/** The same clock in the shape janus asks for. */
export const janusClock: Clock = { now: clock };

/** A failure the caller swallows, logged with its cause. */
export const reportError = (message: string, cause: unknown): void =>
  console.error(message, cause);
