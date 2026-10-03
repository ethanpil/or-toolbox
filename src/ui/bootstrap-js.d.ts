/**
 * Types for the Bootstrap 5.3 JS plugins the shell imports one by one (src/ui/bootstrap.ts). Bootstrap ships no
 * typings and the project adds no @types package for five classes; only the members we call are declared.
 * Check node_modules/bootstrap/js/src/<plugin>.js before using anything new.
 */

declare module 'bootstrap/js/src/modal.js' {
  export interface ModalOptions {
    backdrop?: boolean | 'static';
    focus?: boolean;
    keyboard?: boolean;
  }
  export default class Modal {
    constructor(element: Element, options?: ModalOptions);
    show(relatedTarget?: HTMLElement): void;
    hide(): void;
    toggle(): void;
    dispose(): void;
    handleUpdate(): void;
    static getInstance(element: Element): Modal | null;
    static getOrCreateInstance(element: Element, options?: ModalOptions): Modal;
  }
}

declare module 'bootstrap/js/src/offcanvas.js' {
  export interface OffcanvasOptions {
    backdrop?: boolean | 'static';
    keyboard?: boolean;
    scroll?: boolean;
  }
  export default class Offcanvas {
    constructor(element: Element, options?: OffcanvasOptions);
    show(relatedTarget?: HTMLElement): void;
    hide(): void;
    toggle(): void;
    dispose(): void;
    static getInstance(element: Element): Offcanvas | null;
    static getOrCreateInstance(element: Element, options?: OffcanvasOptions): Offcanvas;
  }
}

declare module 'bootstrap/js/src/toast.js' {
  export interface ToastOptions {
    animation?: boolean;
    autohide?: boolean;
    delay?: number;
  }
  export default class Toast {
    constructor(element: Element, options?: ToastOptions);
    show(): void;
    hide(): void;
    dispose(): void;
    isShown(): boolean;
    static getInstance(element: Element): Toast | null;
    static getOrCreateInstance(element: Element, options?: ToastOptions): Toast;
  }
}

declare module 'bootstrap/js/src/dropdown.js' {
  export interface DropdownOptions {
    autoClose?: boolean | 'inside' | 'outside';
    display?: 'dynamic' | 'static';
  }
  export default class Dropdown {
    constructor(element: Element, options?: DropdownOptions);
    show(): void;
    hide(): void;
    toggle(): void;
    update(): void;
    dispose(): void;
    static getInstance(element: Element): Dropdown | null;
    static getOrCreateInstance(element: Element, options?: DropdownOptions): Dropdown;
  }
}

declare module 'bootstrap/js/src/collapse.js' {
  export interface CollapseOptions {
    parent?: Element | string | null;
    toggle?: boolean;
  }
  export default class Collapse {
    constructor(element: Element, options?: CollapseOptions);
    show(): void;
    hide(): void;
    toggle(): void;
    dispose(): void;
    static getInstance(element: Element): Collapse | null;
    static getOrCreateInstance(element: Element, options?: CollapseOptions): Collapse;
  }
}

declare module 'bootstrap/js/src/util/focustrap.js' {
  export interface FocusTrapOptions {
    trapElement: Element;
    autofocus?: boolean;
  }
  export default class FocusTrap {
    constructor(options: FocusTrapOptions);
    activate(): void;
    deactivate(): void;
  }
}
