import pkg from "../../../package.json" with { type: "json" };

/** The API's version, as `package.json` states it. */
export const version: string = pkg.version;
