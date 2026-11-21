import type { AuthEvent, ClavixEvent } from "@/events/types";

/** The part of the sign-in log the recorder writes through. */
export interface AuthEventWriter {
  record(event: AuthEvent): Promise<void>;
}

/** The bus subscriber that appends auth events to the tenant's log (D12). It throws on a failed write; the bus swallows it (D13). */
export const authRecorder =
  (writer: AuthEventWriter) =>
  async (event: ClavixEvent): Promise<void> => {
    if (event.kind === "auth") await writer.record(event);
  };
