/**
 * TEMPORARY — the "coming in the next step" body of Settings, Models, History and Stats until those pages are
 * built on the shell. Delete with the last of them.
 */
import { url } from '../core/paths';
import { emptyState } from '../ui/components/empty-state';
import { h } from '../ui/dom';
import { icon } from '../ui/icon';

export function comingNext(iconName: string, what: string): HTMLElement {
  return h(
    'div',
    { class: 'card shadow-sm', 'data-testid': 'placeholder' },
    emptyState({
      icon: iconName,
      title: 'Coming in the next step',
      text: what,
      action: h(
        'a',
        { class: 'btn btn-outline-primary', href: url() },
        icon('house', 'me-2'),
        'Back to Home',
      ),
    }),
  );
}
