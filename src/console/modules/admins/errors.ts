import { GraphQLError } from "graphql";
import {
  type ResendRefusal,
  ResendRefusedError,
} from "@/invitations/tenant-invitations";

const RESEND_STATUS = {
  NOT_FOUND: 404,
  INVITATION_NOT_PENDING: 409,
  RESEND_TOO_SOON: 429,
} as const satisfies Record<ResendRefusal, number>;

const RESEND_MESSAGE = {
  NOT_FOUND: "No such invitation",
  INVITATION_NOT_PENDING: "The invitation was accepted or revoked",
  RESEND_TOO_SOON: "The invitation was sent less than a minute ago",
} as const satisfies Record<ResendRefusal, string>;

// A resend's refusals as the contract's GraphQL errors.
export async function refusing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof ResendRefusedError)) throw error;
    const { code, retryAfter } = error;
    throw new GraphQLError(RESEND_MESSAGE[code], {
      extensions: {
        code,
        http: {
          status: RESEND_STATUS[code],
          ...(retryAfter === undefined
            ? {}
            : { headers: { "retry-after": String(retryAfter) } }),
        },
        ...(retryAfter === undefined ? {} : { retryAfter }),
      },
    });
  }
}
