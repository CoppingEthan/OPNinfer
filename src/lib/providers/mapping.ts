import { Provider as DbProvider } from "@prisma/client";
import type { ProviderId } from "./types";

/**
 * Bridge the Prisma enum (member names use underscores: `anthropic_api`) and
 * the spec's hyphenated provider ids (`anthropic-api`). Keep all conversion
 * here so neither representation leaks into the other layer.
 */
export function toProviderId(p: DbProvider): ProviderId {
  switch (p) {
    case DbProvider.openai:
      return "openai";
    case DbProvider.anthropic_api:
      return "anthropic-api";
    case DbProvider.google:
      return "google";
  }
}

export function toDbProvider(id: ProviderId): DbProvider {
  switch (id) {
    case "openai":
      return DbProvider.openai;
    case "anthropic-api":
      return DbProvider.anthropic_api;
    case "google":
      return DbProvider.google;
  }
}
