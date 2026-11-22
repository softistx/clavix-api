import { afterEach, describe, expect, test } from "bun:test";
import { connectionsHarness } from "~/connections-service";

const { service, input, reset, A } = connectionsHarness();

afterEach(reset);

describe("ConnectionsService", () => {
  test("a call reaches the service of its part and the parts share one store", async () => {
    const created = await service.create(A, input(), null);
    expect((await service.find(A, "acme"))?._id).toEqual(created._id);
    const claimed = await service.addDomain(A, "acme", "acme.test");
    expect(claimed.domains).toHaveLength(1);
    const sealed = await service.setSecret(A, "acme", "brand-new-secret");
    expect(sealed.revision).toBe(claimed.revision + 1);
    expect(await service.count(A)).toBe(1);
    expect(await service.delete(A, "acme")).toBe(true);
    expect(await service.list(A)).toEqual([]);
  });

  test("the spec seams are set, read back and cleared", () => {
    const resolver = async () => [];
    const fetcher = async () => new Response("{}");
    expect(service.resolveHost()).toBeUndefined();
    expect(service.fetch()).toBeUndefined();
    service.useHostResolver(resolver);
    service.useFetch(fetcher);
    expect(service.resolveHost()).toBe(resolver);
    expect(service.fetch()).toBe(fetcher);
    service.useHostResolver(undefined);
    service.useFetch(undefined);
    expect(service.resolveHost()).toBeUndefined();
    expect(service.fetch()).toBeUndefined();
  });
});
