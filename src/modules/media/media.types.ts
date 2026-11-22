import type { TenantJanus } from "@/modules/users";

/** Whose picture a request writes: the tenant, the user and the tenant's janus instance. */
export interface AvatarTarget {
  readonly tenantId: string;
  readonly userId: string;
  readonly auth: TenantJanus;
}

/** What `AvatarAccessService` is built over. */
export interface AvatarAccessPorts {
  /** The janus instance of the request's host; `null` for a host that names no tenant. */
  issuers: { forRequest(request: Request): Promise<TenantJanus | null> };
  /** The janus instance of a tenant by id; `null` once the tenant is gone. */
  janusOf(tenantId: string): Promise<TenantJanus | null>;
  /**
   * Whether the console caller may edit the tenant's users' pictures: resolves when so,
   * throws the media refusal that says why not (no console: `not_found`).
   */
  admin(request: Request, tenantId: string): Promise<void>;
  /** Whether the tenant locks the `PICTURE` profile field for its users' self-service. */
  pictureLocked(tenantId: string): Promise<boolean>;
}

/** What `AvatarsService` is built over. */
export interface AvatarsPorts {
  /** The janus instance of the request's host; `null` for a host that names no tenant. */
  issuers: { forRequest(request: Request): Promise<TenantJanus | null> };
  /** Whether the tenant locks the `PICTURE` profile field for its users' self-service. */
  pictureLocked(tenantId: string): Promise<boolean>;
}
