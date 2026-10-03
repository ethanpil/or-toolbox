/**
 * Free-model rule (docs/openrouter-api.md §0, §9.3): an id is free when it ends in `:free`, plus the
 * `openrouter/free` router. A zero price is NOT a free signal (most image, video and music models price at "0").
 */
export function isFreeModelId(id: string): boolean {
  return id.endsWith(':free') || id === 'openrouter/free';
}
