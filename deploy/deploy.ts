#!/usr/bin/env bun
/**
 * Deploys the Clavix staging stack on this host (the shared VPS), by hand and
 * idempotently: git pull both checkouts, build the api and ui images here (no
 * registry), start mongo, redis and minio, db:sync + db:migrate, `up`, wait
 * until every service is healthy, then clean the replaced images. A rerun with nothing
 * changed pulls nothing, rebuilds from cache, migrates nothing and recreates no
 * container.
 *
 *   bun deploy/deploy.ts [--no-pull] [--timeout 300]
 *
 *   --no-pull  skip `git pull` (a checkout on a feature branch)
 *   --timeout  seconds to wait for health (default 300)
 *
 * The env file is deploy/.env: it must exist and be mode 600, or the script
 * refuses to run. Traefik (nxgt-docker) must be up: the stack joins its external
 * `proxy` network. Caddy is not started. docs/operations.md, "Staging".
 *
 * Cleanup after a healthy start: the images the new build replaced (and every
 * other id under the app's repositories), dangling images, and the build cache
 * older than 24 h. Never `docker system prune`, never volumes.
 */

import { $ } from "bun";
import {
  API_ROOT,
  fail,
  flagValue,
  imageRepository,
  loadStack,
  staleImageIds,
  uiContext,
} from "./lib";

const args = Bun.argv.slice(2);
const known = new Set(["--no-pull", "--timeout"]);
for (const a of args) {
  if (a.startsWith("--") && !known.has(a)) fail(`unknown flag ${a}`);
}
const timeout = flagValue(args, "--timeout") ?? "300";
if (!/^[1-9][0-9]*$/.test(timeout)) fail("--timeout is a number of seconds");

const stack = await loadStack();
const step = (name: string, detail = "") =>
  console.log(`  ${name.padEnd(9)} ${detail}`);

const proxy = await $`docker network inspect proxy`.quiet().nothrow();
if (proxy.exitCode !== 0)
  fail(
    "the external docker network `proxy` does not exist (nxgt-docker's traefik creates it)",
  );

if (args.includes("--no-pull")) {
  step("skip", "git pull (--no-pull)");
} else {
  for (const dir of [API_ROOT, uiContext(stack.values)]) {
    const out = (await $`git pull --ff-only`.cwd(dir).text())
      .trim()
      .split("\n")
      .pop();
    step("pull", `${dir}: ${out}`);
  }
}

const imageId = async (image: string): Promise<string> =>
  (await $`docker image inspect --format {{.Id}} ${image}`.quiet().nothrow())
    .text()
    .trim();

step("build", "api, ui, minio-init (cached layers make a rerun cheap)");
await stack.compose("build", "api", "ui", "minio-init");

step("data", "mongo, redis, minio");
await stack.compose(
  "up",
  "-d",
  "--wait",
  "--wait-timeout",
  timeout,
  "mongo",
  "redis",
  "minio",
);

step("migrate", "db:sync then db:migrate (one-shot api container)");
await stack.compose(
  "run",
  "--rm",
  "--no-deps",
  // The one-off carries the api's labels: keep traefik from routing to it.
  "--label",
  "traefik.enable=false",
  "api",
  "sh",
  "-c",
  "bun run db:sync && bun run db:migrate",
);

step("up", "");
await stack.compose(
  "up",
  "-d",
  "--remove-orphans",
  "--wait",
  "--wait-timeout",
  timeout,
);
await stack.compose("ps", "--format", "table {{.Name}}\t{{.Status}}");
step("healthy", "clavix is up");

// Cleanup, never fatal: a failure is logged and the deploy still succeeds.
const cleanup = async (
  label: string,
  run: () => Promise<{ exitCode: number }>,
) => {
  try {
    const r = await run();
    if (r.exitCode !== 0)
      step("cleanup", `${label} failed (exit ${r.exitCode}), ignored`);
  } catch (error) {
    step("cleanup", `${label} failed (${String(error)}), ignored`);
  }
};
const current = new Set<string>();
for (const image of stack.images) {
  const id = await imageId(image);
  if (id) current.add(id);
}
const listed: string[] = [];
for (const image of stack.images) {
  const repo = imageRepository(image);
  const out = await $`docker image ls --no-trunc -q ${repo}`.quiet().nothrow();
  listed.push(...out.text().split("\n"));
}
for (const id of staleImageIds(listed, current)) {
  await cleanup(`remove previous image ${id.slice(0, 19)}`, () =>
    $`docker image rm ${id}`.quiet().nothrow(),
  );
}
await cleanup("docker image prune", () =>
  $`docker image prune -f`.quiet().nothrow(),
);
await cleanup("docker builder prune", () =>
  $`docker builder prune -f --filter until=24h`.quiet().nothrow(),
);
step("cleanup", "old images and build cache older than 24 h pruned");
