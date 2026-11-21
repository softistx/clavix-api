import type { MailMessage } from "@softistx/mail";
import { txtNameOf } from "./domains.rules";

const htmlEscape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The e-mail to a tenant's owners when a verified domain fails its TXT
 * recheck for good: it names the record to restore and says what keeps
 * working (the slug host, and the issuer, which does not change by itself).
 */
export function lapsedDomainMail(input: {
  to: string[];
  from: { name: string; address: string };
  tenantName: string;
  host: string;
  txtToken: string;
  wasPrimary: boolean;
}): MailMessage {
  const record = `${txtNameOf(input.host)}  TXT  ${input.txtToken}`;
  const lines = [
    `The domain ${input.host} of ${input.tenantName} no longer shows its verification record for 7 days, so it is now unverified.`,
    `Publish this record again, then verify the domain in the console:`,
    record,
    input.wasPrimary
      ? "It is your primary domain: your issuer is unchanged and nothing is switched for you, but its certificate will not be renewed until it is verified again. You can also make another domain primary."
      : "Your other hosts keep working.",
  ];
  return {
    from: input.from,
    to: input.to,
    subject: `Domain ${input.host} is no longer verified`,
    text: lines.join("\n\n"),
    html: lines.map((line) => `<p>${htmlEscape(line)}</p>`).join(""),
  };
}
