/** The TXT value to publish: random per claim, so it names this tenant's claim on this host. */
export const mintToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `clavix-verify=${Buffer.from(bytes).toString("base64url")}`;
};
