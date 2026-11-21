/**
 * Where an App's frontend is served. Human-facing routes use the mutable
 * slug; immutable ids stay in technical API paths.
 */
export function appSurfaceSource(slug: string) {
  return `/app/${slug}/embed/`;
}
