/**
 * Server-only: the model catalog in use. Starts from the bundled snapshot;
 * the background refresh swaps in a newer validated copy (`setActiveCatalog`).
 */
import bundledData from './catalog.json';
import {
  catalogSchema,
  type Catalog,
  type CatalogModel,
  type CatalogProvider,
} from './types';

export * from './types';

const bundled: Catalog = catalogSchema.parse(bundledData);

type Indexed = {
  catalog: Catalog;
  providers: Map<string, CatalogProvider>;
  models: Map<string, Map<string, CatalogModel>>;
};

function index(catalog: Catalog): Indexed {
  return {
    catalog,
    providers: new Map(catalog.providers.map((p) => [p.id, p])),
    models: new Map(
      Object.entries(catalog.models).map(([provider, models]) => [
        provider,
        new Map(models.map((model) => [model.id, model])),
      ]),
    ),
  };
}

let active = index(bundled);

export function bundledCatalog(): Catalog {
  return bundled;
}

export function activeCatalog(): Catalog {
  return active.catalog;
}

/** Use `catalog` from now on in this process. */
export function setActiveCatalog(catalog: Catalog): void {
  active = index(catalog);
}

/** Pick the copy with the newest upstream data; the bundled one wins ties. */
export function newestCatalog(candidate: Catalog | null): Catalog {
  if (!candidate) return bundled;
  return Date.parse(candidate.source.generatedAt) >
    Date.parse(bundled.source.generatedAt)
    ? candidate
    : bundled;
}

export function catalogProviders(): readonly CatalogProvider[] {
  return active.catalog.providers;
}

export function catalogProvider(id: string): CatalogProvider | undefined {
  return active.providers.get(id);
}

export function catalogModels(providerId: string): readonly CatalogModel[] {
  return active.catalog.models[providerId] ?? [];
}

export function catalogModel(
  providerId: string,
  modelId: string,
): CatalogModel | undefined {
  return active.models.get(providerId)?.get(modelId);
}

/** `<catalog provider>/<model id>`; model ids may contain slashes. */
export function catalogRef(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

export function parseCatalogRef(
  ref: string,
): { providerId: string; modelId: string } | null {
  const sep = ref.indexOf('/');
  if (sep <= 0 || sep === ref.length - 1) return null;
  return { providerId: ref.slice(0, sep), modelId: ref.slice(sep + 1) };
}

export function catalogModelByRef(ref: string): CatalogModel | undefined {
  const parsed = parseCatalogRef(ref);
  return parsed ? catalogModel(parsed.providerId, parsed.modelId) : undefined;
}

/**
 * Find catalog metadata for a model id: first under the linked catalog
 * provider, then under any provider in catalog order (vendors before
 * gateways). Returns the catalog ref, or null.
 */
export function matchCatalogModel(
  linkedProviderId: string | null,
  modelId: string,
  kind: CatalogModel['kind'],
): string | null {
  const fits = (model: CatalogModel | undefined) => model?.kind === kind;
  if (linkedProviderId && fits(catalogModel(linkedProviderId, modelId)))
    return catalogRef(linkedProviderId, modelId);
  for (const provider of active.catalog.providers) {
    if (fits(catalogModel(provider.id, modelId)))
      return catalogRef(provider.id, modelId);
  }
  return null;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s_\-.:/]+/g, '');
}

export type CatalogSearch = {
  providerId?: string;
  query?: string;
  kind?: CatalogModel['kind'];
  limit: number;
  offset?: number;
};

export type CatalogSearchHit = { providerId: string; model: CatalogModel };

/**
 * Search by name or id, ignoring case and punctuation. Every whitespace
 * separated term must match. Returns one page plus the total match count.
 */
export function searchCatalogModels(search: CatalogSearch): {
  hits: CatalogSearchHit[];
  total: number;
} {
  const terms = (search.query ?? '')
    .split(/\s+/)
    .map(normalize)
    .filter(Boolean);
  const providerIds = search.providerId
    ? [search.providerId]
    : active.catalog.providers.map((p) => p.id);
  const matches: CatalogSearchHit[] = [];
  for (const providerId of providerIds) {
    for (const model of catalogModels(providerId)) {
      if (search.kind && model.kind !== search.kind) continue;
      const haystack = `${normalize(model.name)} ${normalize(model.id)}`;
      if (terms.every((term) => haystack.includes(term)))
        matches.push({ providerId, model });
    }
  }
  const offset = search.offset ?? 0;
  return {
    hits: matches.slice(offset, offset + search.limit),
    total: matches.length,
  };
}
