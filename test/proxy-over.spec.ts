import { describe, expect, test } from "bun:test";
import { overriding } from "~/proxy-over";

class Store {
  prefix = "p";
  read(key: string): string {
    return `${this.prefix}:${key}`;
  }
  write(key: string): string {
    return `w:${this.prefix}:${key}`;
  }
}

describe("overriding", () => {
  test("replaces the named method only", () => {
    const store = new Store();
    const view = overriding(store, "read", () => "fake");
    expect(view.read("a")).toBe("fake");
    expect(view.write("a")).toBe("w:p:a");
  });

  test("binds the other methods to the target", () => {
    const store = new Store();
    const view = overriding(store, "read", () => "fake");
    const { write } = view;
    expect(write("a")).toBe("w:p:a");
  });

  test("leaves the target untouched", () => {
    const store = new Store();
    overriding(store, "read", () => "fake");
    expect(store.read("a")).toBe("p:a");
  });

  test("passes plain fields through", () => {
    const store = new Store();
    const view = overriding(store, "read", () => "fake");
    expect(view.prefix).toBe("p");
    store.prefix = "q";
    expect(view.prefix).toBe("q");
  });
});
