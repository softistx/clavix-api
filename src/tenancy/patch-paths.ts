import { isRecord } from "@/shared/values";

const head = (path: string) => path.split(".")[0];

/**
 * Whether a patch writes or removes `field`: as a field, as a path under any
 * operator (`$set: { "field.x": 1 }`), or on either side of a `$rename`.
 */
export function patchTouches(patch: unknown, field: string): boolean {
  if (!isRecord(patch)) return false;
  return Object.entries(patch).some(([key, value]) => {
    const paths =
      key.startsWith("$") && isRecord(value)
        ? Object.entries(value).flatMap(([path, target]) =>
            key === "$rename" ? [path, String(target)] : [path],
          )
        : [key];
    return paths.some((path) => head(path) === field);
  });
}
