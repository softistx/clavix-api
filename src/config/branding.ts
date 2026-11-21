import { logoRoute } from "@/modules/branding/branding.logo-route";
import { BrandingService } from "@/modules/branding/branding.service";
import { mongo } from "./db";
import { tenantResolver } from "./tenancy";

/** The real brand store. The `branding` collection is tenant-owned: only this wiring and its module reach it. */
export const brandingService = new BrandingService(mongo.db.branding);

/** `GET /branding/logo` over the real store and resolver. */
export const serveLogo = logoRoute({
  resolver: tenantResolver,
  service: brandingService,
});
