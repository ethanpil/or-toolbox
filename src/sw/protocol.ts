/**
 * Messages between a page (src/core/sw-register.ts) and the service worker
 * (src/sw/sw.ts). Types only, so both sides can import this file.
 *
 * A page sends a `WorkerRequest` together with one MessageChannel port; the
 * worker always answers on that port with a `WorkerStatus`.
 */

/**
 * The Cross-Origin-Embedder-Policy value the worker adds to responses.
 * `credentialless` is preferred (cross-origin images and media keep loading,
 * just without cookies). Browsers that do not know it ignore the header and
 * stay un-isolated, so they are switched to `require-corp`.
 */
export type CoepMode = 'credentialless' | 'require-corp';

export type WorkerRequest = { type: 'GET_STATUS' } | { type: 'SET_COEP_MODE'; mode: CoepMode };

export interface WorkerStatus {
  /** Build hash of the offline shell this worker serves. */
  version: string;
  coepMode: CoepMode;
  /** Number of files in the offline shell. */
  precached: number;
  /**
   * True if this worker served the asking page's document, i.e. the document
   * already carries the isolation headers. False after a first visit or a
   * forced reload, when the document came straight from the network.
   */
  servedDocument: boolean;
}
