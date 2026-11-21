// The e-mails sent after the answer, so the time a request takes does not tell
// whether the address has an account (janus's sign-in code guide). A failure
// is logged by its name only, never with the address or the challenge.
const inFlight = new Set<Promise<void>>();

export function afterAnswer(
  task: () => Promise<void>,
  report: (message: string) => void = (message) => console.warn(message),
): void {
  const run: Promise<void> = task()
    .catch((error: unknown) => {
      report(
        `auth: sign-in code not sent (${
          error instanceof Error ? error.name : "unknown error"
        })`,
      );
    })
    .finally(() => {
      inFlight.delete(run);
    });
  inFlight.add(run);
}

/** Resolves when every e-mail started so far has been handed over or has failed. */
export async function settled(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

/** The shutdown drain: waits for the mails in flight, at most `timeoutMs`. `"timeout"` means some were still in flight (lost; the visitor asks again). */
export async function drain(
  timeoutMs = 10_000,
): Promise<"drained" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([settled().then(() => "drained" as const), late]);
  } finally {
    clearTimeout(timer);
  }
}
