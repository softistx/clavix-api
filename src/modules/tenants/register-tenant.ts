import type { TypedCollection } from "@softistx/mongo";
import { partitionOf } from "./identity";
import { slugProblem } from "./slug";
import { InvalidSlugError, SlugTakenError } from "./tenants.errors";
import type { Tenant, tenants } from "./tenants.model";
import type { TenantsService } from "./tenants.service";

/** A bad command line or a refused tenant, in words for the operator. */
export class TenantInputError extends Error {
  override name = "TenantInputError";
}

export interface RegisterTenantInput {
  slug: string;
  name: string;
  /** Open sign-up for unknown e-mails. Default: closed (invitation only). */
  signUp?: boolean;
}

export interface RegisterTenantOptions {
  /** The service that owns the rules (slug, reserved slugs, first key hook). */
  service: TenantsService;
  /** The tenants collection, to read a stored tenant and a deleted one's slug. */
  collection: TypedCollection<typeof tenants>;
}

export interface RegisteredTenant {
  /** `false` when the tenant already existed with these values: nothing was written. */
  created: boolean;
  /** The tenant's id in hex: its partition everywhere. */
  tenantId: string;
  slug: string;
  name: string;
  status: Tenant["status"];
  signUp: boolean;
}

const describe = (tenant: Tenant, created: boolean): RegisteredTenant => ({
  created,
  tenantId: partitionOf(tenant._id),
  slug: tenant.slug,
  name: tenant.name,
  status: tenant.status,
  signUp: tenant.signUp,
});

/**
 * Creates a tenant through `TenantsService` (slug rules, reserved slugs, the
 * first signing key), or reports the one already there. Re-running with the
 * same values changes nothing; a live tenant with other values is refused
 * rather than edited, and a deleted tenant's slug stays reserved.
 */
export async function registerTenant(
  { service, collection }: RegisterTenantOptions,
  input: RegisterTenantInput,
): Promise<RegisteredTenant> {
  const problem = slugProblem(input.slug);
  if (problem !== undefined) {
    throw new TenantInputError(`invalid slug: ${problem}`);
  }
  const name = input.name.trim();
  if (name === "") throw new TenantInputError("--name must not be empty");

  const existing = await collection.findFirst({ slug: input.slug });
  if (existing !== undefined) {
    if (
      existing.name !== name ||
      (input.signUp !== undefined && existing.signUp !== input.signUp)
    ) {
      throw new TenantInputError(
        `the tenant "${input.slug}" already exists (name "${existing.name}", sign-up ${existing.signUp ? "open" : "closed"}); this script does not edit it`,
      );
    }
    return describe(existing, false);
  }
  if ((await collection.raw.findOne({ slug: input.slug })) !== null) {
    throw new TenantInputError(
      `the slug "${input.slug}" belongs to a deleted tenant and stays reserved`,
    );
  }
  try {
    return describe(await service.create({ ...input, name }), true);
  } catch (error) {
    if (error instanceof InvalidSlugError || error instanceof SlugTakenError) {
      throw new TenantInputError(error.message);
    }
    throw error;
  }
}
