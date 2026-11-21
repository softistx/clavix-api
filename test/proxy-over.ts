/**
 * A view of `target` whose `method` is `replace`: every other member is the
 * target's own (functions bound to it). The target is left untouched, so a
 * spec lays a race or a failure over a shared collection without changing it.
 */
export function overriding<T extends object, K extends keyof T>(
  target: T,
  method: K,
  replace: T[K],
): T {
  return new Proxy(target, {
    get(real, property) {
      if (property === method) return replace;
      const value: unknown = Reflect.get(real, property, real);
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
}
