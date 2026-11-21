import type { MailMessage } from "@softistx/mail";
import { htmlEscape } from "@/shared/html";

/**
 * The e-mail to a tenant's owners when an endpoint is switched off after 5
 * deliveries given up in a row (D20). It names the endpoint's origin, never
 * its path (which may hold a token), and says how to switch it on again.
 */
export function disabledEndpointMail(input: {
  to: string[];
  from: { name: string; address: string };
  tenantName: string;
  url: string;
}): MailMessage {
  const origin = new URL(input.url).origin;
  const lines = [
    `The webhook endpoint ${origin} of ${input.tenantName} did not answer with a success status for 5 events in a row, even after the retries, so it is now switched off.`,
    "Nothing is sent to it until you fix the receiver and switch the endpoint on again in the console.",
  ];
  return {
    from: input.from,
    to: input.to,
    subject: `Webhook endpoint ${origin} is switched off`,
    text: lines.join("\n\n"),
    html: lines.map((line) => `<p>${htmlEscape(line)}</p>`).join(""),
  };
}
