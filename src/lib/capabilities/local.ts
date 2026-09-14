import type { Capability } from "./types";

/**
 * Capabilities built for ONE organisation, which therefore do not ship in the
 * public product.
 *
 * This file is the seam. Here it is an EMPTY list, permanently — nothing
 * upstream should ever edit it. A private deployment that carries client
 * tooling replaces this one file and adds its capability modules alongside it;
 * because upstream never touches it, pulling upstream into such a repository
 * can never conflict here, and because everything else a client capability
 * needs is a NEW file, the whole private layer is additive.
 *
 * A capability is a self-contained module implementing `Capability` (see
 * `types.ts`): its own tools, its own config schema, its own data source. It
 * ships switched OFF and is enabled per instance on Admin → Tools, which
 * renders it generically — including the data-source line it declares for
 * itself — without ever knowing its id.
 *
 * To add one:
 *
 *     import { acmeListings } from "./acme-listings";
 *     export const LOCAL_CAPABILITIES: Capability[] = [acmeListings];
 */
export const LOCAL_CAPABILITIES: Capability[] = [];
