let counter = 0;

/** A page-unique element id for label/aria wiring: `uid('model-search')` → `model-search-7`. */
export function uid(prefix = 'or'): string {
  counter += 1;
  return `${prefix}-${counter}`;
}
