import type { ReadDocumentOf } from "@softistx/mongo";
import type { AuthEventType, authEvents } from "./audit.model";

export type StoredAuthEvent = ReadDocumentOf<typeof authEvents>;

/** What narrows the sign-in log; every field is optional and they combine with AND. */
export interface AuthEventFilter {
  from?: Date | null | undefined;
  to?: Date | null | undefined;
  types?: readonly AuthEventType[] | null | undefined;
  userId?: string | null | undefined;
  clientId?: string | null | undefined;
  outcome?: "success" | "failure" | null | undefined;
}

/** One page of the sign-in log, with how many events match in all. */
export interface AuthEventPage {
  items: StoredAuthEvent[];
  nextCursor: string | null;
  totalCount: number;
}
