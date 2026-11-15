import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The image the compose `tools` profile builds on; the drill uses its database tools. */
export const TOOLS_IMAGE = "mongo:8";

/** Whether Docker answers and the tools image is already local (never pulled by a spec). */
export function dockerToolsAvailable(): boolean {
  if (Bun.which("docker") === null) return false;
  const probe = Bun.spawnSync(["docker", "image", "inspect", TOOLS_IMAGE], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return probe.exitCode === 0;
}

// One POSIX wrapper stands in for `mongodump` / `mongorestore`: it runs the tool
// in a throwaway container, so the host needs no database tools. The archive
// crosses the container boundary on stdout / stdin (no bind mount), and the URI
// is pointed at the host (`host.docker.internal`) as a direct connection,
// because the replica set the host's mongod advertises is `127.0.0.1`.
const WRAPPER = `#!/bin/sh
set -eu
set -f
tool=$1; shift
uri=; archive=; rest=
for arg in "$@"; do
  case $arg in
    --uri=*) uri=\${arg#--uri=} ;;
    --archive=*) archive=\${arg#--archive=} ;;
    *) rest="$rest $arg" ;;
  esac
done
uri=$(printf '%s' "$uri" | sed -e 's#//127\\.0\\.0\\.1#//host.docker.internal#; s#//localhost#//host.docker.internal#; s#replicaSet=[^&]*#directConnection=true#')
case $tool in
  mongodump)
    docker run --rm --add-host=host.docker.internal:host-gateway ${TOOLS_IMAGE} \\
      mongodump --uri="$uri" --archive $rest > "$archive" ;;
  mongorestore)
    docker run --rm -i --add-host=host.docker.internal:host-gateway ${TOOLS_IMAGE} \\
      mongorestore --uri="$uri" --archive $rest < "$archive" ;;
esac
`;

/** Writes the two wrappers into `dir` and returns the paths to give as MONGODUMP / MONGORESTORE. */
export function writeDockerToolWrappers(dir: string): {
  mongodump: string;
  mongorestore: string;
} {
  mkdirSync(dir, { recursive: true });
  const body = (tool: string) =>
    `${WRAPPER.split("\n")[0]}\nexec sh ${join(dir, "mongo-tool.sh")} ${tool} "$@"\n`;
  const shared = join(dir, "mongo-tool.sh");
  writeFileSync(shared, WRAPPER);
  const make = (tool: "mongodump" | "mongorestore") => {
    const path = join(dir, tool);
    writeFileSync(path, body(tool));
    chmodSync(path, 0o755);
    return path;
  };
  return { mongodump: make("mongodump"), mongorestore: make("mongorestore") };
}
