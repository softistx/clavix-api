import type { ClavixEvent } from "./types";

export type Subscriber = (event: ClavixEvent) => void | Promise<void>;

export interface EventBus {
  /** Hands the event to every subscriber, awaited. Never rejects (D13). */
  emit(event: ClavixEvent): Promise<void>;
  subscribe(subscriber: Subscriber): () => void;
}

export interface EventBusOptions {
  /**
   * Called when a subscriber throws: the event is lost for that subscriber and
   * the others still get it. Default: a console line. Counted in telemetry
   * where a counter is wired.
   */
  onFailure?: (error: unknown, event: ClavixEvent) => void;
}

/**
 * The Clavix event bus (D12, D13). A subscriber's failure is reported and
 * swallowed: an event never fails the sign-in that raised it.
 */
export function createEventBus(options: EventBusOptions = {}): EventBus {
  const subscribers = new Set<Subscriber>();
  const onFailure =
    options.onFailure ??
    ((error, event) =>
      console.error(`events: a subscriber failed on ${event.kind}`, error));
  return {
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    async emit(event) {
      await Promise.all(
        [...subscribers].map(async (subscriber) => {
          try {
            await subscriber(event);
          } catch (error) {
            try {
              onFailure(error, event);
            } catch {
              // a failing failure hook must not fail the caller either
            }
          }
        }),
      );
    },
  };
}
