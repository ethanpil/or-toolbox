import { version } from '../../../package.json';
import { url } from '../../core/paths';
import { h } from '../dom';
import { icon } from '../icon';
import { REPO_URL } from './links';

export function footer(): HTMLElement {
  return h(
    'footer',
    { class: 'or-footer border-top mt-auto' },
    h(
      'div',
      {
        class:
          'container-xxl d-flex flex-wrap align-items-center justify-content-between gap-3 py-4 small text-body-secondary',
      },
      h(
        'div',
        { class: 'd-flex align-items-center gap-2' },
        h('img', { src: url('icons/logo.svg'), alt: '', width: 20, height: 20 }),
        h('span', null, 'ORtoolbox ', h('span', { 'data-testid': 'app-version' }, `v${version}`)),
        h(
          'span',
          { class: 'd-none d-sm-inline' },
          '· Runs in your browser on your own OpenRouter key.',
        ),
      ),
      h(
        'nav',
        { 'aria-label': 'Footer' },
        h(
          'ul',
          { class: 'list-inline mb-0 d-flex flex-wrap gap-3' },
          h('li', null, h('a', { class: 'text-body-secondary', href: url('privacy/') }, 'Privacy')),
          h(
            'li',
            null,
            h('a', { class: 'text-body-secondary', href: url('diagnostics/') }, 'Diagnostics'),
          ),
          h(
            'li',
            null,
            h(
              'a',
              {
                class: 'text-body-secondary d-inline-flex align-items-center gap-1',
                href: REPO_URL,
                target: '_blank',
                rel: 'noopener noreferrer',
              },
              icon('github'),
              'GitHub',
            ),
          ),
        ),
      ),
    ),
  );
}
