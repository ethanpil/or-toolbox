/**
 * `imageViewer()`: shows an image on a checkerboard (so transparency is visible), fitted to the panel by
 * default, with Fit / actual size and zoom buttons. Pass a Blob (an object URL is made and revoked on
 * `dispose()`) or an existing URL such as `results.objectUrl(id)`.
 */
import { h } from '../dom';
import { icon } from '../icon';

export interface ImageViewerOptions {
  /** An object URL or same-origin URL (never a remote http URL: the CSP forbids remote images). */
  src?: string;
  blob?: Blob;
  alt: string;
  testId?: string;
}

export interface ImageViewer {
  readonly element: HTMLElement;
  readonly image: HTMLImageElement;
  setSource(source: { src?: string; blob?: Blob; alt?: string }): void;
  dispose(): void;
}

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

export function imageViewer(options: ImageViewerOptions): ImageViewer {
  let ownUrl: string | null = null;
  let mode: 'fit' | 'zoom' = 'fit';
  let zoom = 1;

  const image = h('img', { class: 'or-viewer-image', alt: options.alt, decoding: 'async' });
  const frame = h(
    'div',
    {
      class: 'or-viewer-frame or-checkerboard',
      tabIndex: 0,
      role: 'group',
      'aria-label': `Image: ${options.alt}`,
    },
    image,
  );
  const zoomLabel = h(
    'span',
    { class: 'small text-body-secondary or-viewer-zoom', 'aria-live': 'polite' },
    'Fit',
  );

  const apply = (): void => {
    frame.classList.toggle('is-zoomed', mode === 'zoom');
    if (mode === 'fit') {
      image.style.removeProperty('width');
      zoomLabel.textContent = 'Fit';
    } else {
      image.style.width = image.naturalWidth
        ? `${Math.round(image.naturalWidth * zoom)}px`
        : `${zoom * 100}%`;
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    }
    fitButton.setAttribute('aria-pressed', String(mode === 'fit'));
    actualButton.setAttribute('aria-pressed', String(mode === 'zoom' && zoom === 1));
  };

  const step = (direction: 1 | -1): void => {
    if (mode === 'fit') {
      // Start from the fitted scale so the first click does not jump.
      const fitted = image.naturalWidth ? image.clientWidth / image.naturalWidth : 1;
      zoom = fitted;
      mode = 'zoom';
    }
    const next =
      direction > 0
        ? ZOOM_STEPS.find((value) => value > zoom + 0.001)
        : [...ZOOM_STEPS].reverse().find((value) => value < zoom - 0.001);
    zoom = next ?? zoom;
    apply();
  };

  const toolButton = (
    label: string,
    iconName: string,
    onClick: () => void,
    pressed?: boolean,
  ): HTMLButtonElement =>
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-secondary',
        'aria-label': label,
        title: label,
        ...(pressed === undefined ? {} : { 'aria-pressed': String(pressed) }),
        onclick: onClick,
      },
      icon(iconName),
    );

  const fitButton = toolButton(
    'Fit to panel',
    'arrows-angle-contract',
    () => {
      mode = 'fit';
      apply();
    },
    true,
  );
  const actualButton = toolButton(
    'Actual size',
    'aspect-ratio',
    () => {
      mode = 'zoom';
      zoom = 1;
      apply();
    },
    false,
  );

  const element = h(
    'div',
    { class: 'or-viewer', 'data-testid': options.testId ?? 'image-viewer' },
    h(
      'div',
      {
        class: 'd-flex align-items-center gap-1 mb-2',
        role: 'toolbar',
        'aria-label': 'Image view',
      },
      fitButton,
      actualButton,
      toolButton('Zoom out', 'zoom-out', () => step(-1)),
      toolButton('Zoom in', 'zoom-in', () => step(1)),
      h('span', { class: 'ms-2' }, zoomLabel),
    ),
    frame,
  );

  const setSource = (source: { src?: string; blob?: Blob; alt?: string }): void => {
    if (ownUrl) URL.revokeObjectURL(ownUrl);
    ownUrl = source.blob ? URL.createObjectURL(source.blob) : null;
    image.src = ownUrl ?? source.src ?? '';
    if (source.alt !== undefined) {
      image.alt = source.alt;
      frame.setAttribute('aria-label', `Image: ${source.alt}`);
    }
    image.classList.add('or-fade-in');
  };
  image.addEventListener('load', apply);
  setSource(options);

  return {
    element,
    image,
    setSource,
    dispose() {
      if (ownUrl) URL.revokeObjectURL(ownUrl);
      ownUrl = null;
    },
  };
}
