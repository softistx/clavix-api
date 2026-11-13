import { defineModel } from "@softistx/janus/permissions";

/** The roles of the console, strongest first. */
export const ROLES = ["owner", "admin", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** Whether a stored string is one of the console's roles. */
export const isRole = (value: string): value is Role =>
  (ROLES as readonly string[]).includes(value);

/** What a guard asks for. */
export type Permission = "manage" | "edit" | "view";

/**
 * Who may do what in the console (ReBAC, janus relations): one `platform`
 * object (the operators of Clavix) and a `tenant` object per tenant, each
 * with owner, admin and viewer holders (users of the `clavix` tenant).
 * Permissions widen with the role: view <- viewer, edit <- admin, manage <-
 * owner. A tenant is linked to the platform (`platform` relation), so a
 * platform role carries over to every tenant (platform owner manages them,
 * admin edits, viewer views); a tenant role never reaches another tenant.
 */
export const model = defineModel({
  subjects: ["user"],
  types: {
    platform: {
      related: { owner: ["user"], admin: ["user"], viewer: ["user"] },
      permits: {
        manage: ["owner"],
        edit: ["admin", "manage"],
        view: ["viewer", "edit"],
      },
    },
    tenant: {
      related: {
        owner: ["user"],
        admin: ["user"],
        viewer: ["user"],
        platform: ["platform"],
      },
      permits: {
        manage: ["owner", "platform->manage"],
        edit: ["admin", "manage", "platform->edit"],
        view: ["viewer", "edit", "platform->view"],
      },
    },
  },
});
