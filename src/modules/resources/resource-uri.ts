/** The resource URI's problem (RFC 8707 §2: absolute, no fragment), or `null`. */
export function resourceUriProblem(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "must be an absolute URI";
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return "must be https (http only on a loopback host)";
  }
  if (url.hash !== "" || uri.includes("#")) return "must have no fragment";
  if (url.username !== "" || url.password !== "") {
    return "must carry no credentials";
  }
  return null;
}
