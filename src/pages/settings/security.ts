/**
 * Settings → Passphrase lock: turn it on (passphrase twice, with a strength hint), lock now or unlock, change
 * the passphrase, turn it off, and the auto-lock delay. Everything goes through `keys.lock`; the shared-origin
 * caveat of github.io is spelled out with a link to the Privacy page.
 */
import { errorCode } from '../../core/errors';
import { url } from '../../core/paths';
import { MAX_AUTO_LOCK_MINUTES } from '../../core/settings/schema';
import type { CoreServices } from '../../core/types';
import { type Child, h } from '../../ui/dom';
import { presentError } from '../../ui/feedback/errors';
import { toast } from '../../ui/feedback/toast';
import { unlockDialog } from '../../ui/feedback/unlock';
import { icon } from '../../ui/icon';
import { saveSettings } from '../../ui/settings-actions';
import { parseWhole } from './logic';
import {
  busy,
  card,
  focusSectionHeading,
  numberField,
  passphraseInput,
  rerender,
  type SectionView,
  validNewPassphrase,
} from './ui';

export function securitySection(core: CoreServices): SectionView {
  const lock = core.keys.lock;
  const body = h('div');

  const enableCard = (): HTMLElement => {
    const next = passphraseInput({
      label: 'Passphrase',
      autocomplete: 'new-password',
      testId: 'lock-new',
      strength: true,
    });
    const confirm = passphraseInput({
      label: 'Repeat the passphrase',
      autocomplete: 'new-password',
      testId: 'lock-confirm',
    });
    const submit = h(
      'button',
      { type: 'submit', class: 'btn btn-primary', 'data-testid': 'lock-enable' },
      icon('lock', 'me-2'),
      'Turn on the lock',
    );
    const form = h(
      'form',
      {
        class: 'vstack gap-3 or-form-narrow',
        noValidate: true,
        'data-testid': 'lock-enable-form',
        onsubmit: (event: Event) => {
          event.preventDefault();
          if (!validNewPassphrase(next, confirm)) return;
          void busy(submit, async () => {
            try {
              await lock.enable(next.input.value);
              // This form is replaced by the lock's status: focus moves to its Lock now button.
              render();
              focusToggle();
              toast({
                message: 'Passphrase lock is on. Your keys are encrypted.',
                variant: 'success',
              });
            } catch (error) {
              await presentError(error);
            }
          });
        },
      },
      next.element,
      confirm.element,
      h('div', null, submit),
    );
    return card(
      {
        title: 'Passphrase lock',
        icon: 'shield-lock',
        text: 'Off: your keys are stored unencrypted in this browser.',
        actions: h(
          'span',
          { class: 'badge rounded-pill text-bg-secondary', 'data-testid': 'lock-state' },
          'Off',
        ),
        testId: 'lock-card',
      },
      h(
        'p',
        null,
        'Encrypt your keys with a passphrase. ORtoolbox turns it into an AES-GCM key with PBKDF2 (600,000 rounds of SHA-256) and stores only the encrypted keys. You unlock once per tab; closing the tab, auto-lock or Lock now locks them again.',
      ),
      h(
        'div',
        { class: 'alert alert-warning d-flex gap-2 small' },
        icon('exclamation-triangle-fill', 'lh-1 mt-1'),
        h(
          'div',
          null,
          h('strong', null, 'A forgotten passphrase cannot be recovered.'),
          ' You would have to remove your keys and add them again (they keep working on OpenRouter).',
        ),
      ),
      form,
    );
  };

  const statusCard = (): HTMLElement => {
    const unlocked = lock.unlocked();
    return card(
      {
        title: 'Passphrase lock',
        icon: 'shield-lock',
        text: unlocked
          ? 'On: your keys are encrypted, and unlocked in this tab.'
          : 'On: your keys are encrypted and locked. Unlock them to run tools.',
        actions: h(
          'span',
          {
            class: ['badge rounded-pill', unlocked ? 'text-bg-success' : 'text-bg-warning'],
            'data-testid': 'lock-state',
          },
          unlocked ? 'Unlocked' : 'Locked',
        ),
        testId: 'lock-card',
      },
      unlocked
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-outline-primary',
              'data-testid': 'lock-now',
              // Lock now and Unlock replace each other; focus follows from one to the other.
              'data-focus-key': 'lock:toggle',
              onclick: () => {
                lock.lockNow();
                toast({ message: 'Keys locked in this tab.', variant: 'success' });
              },
            },
            icon('lock', 'me-2'),
            'Lock now',
          )
        : h(
            'button',
            {
              type: 'button',
              class: 'btn btn-primary',
              'data-testid': 'lock-unlock',
              'data-focus-key': 'lock:toggle',
              onclick: () =>
                void unlockDialog()
                  .then((ok) => {
                    // The dialog returned focus to this button, which unlocking replaced.
                    if (!ok) return;
                    render();
                    focusToggle();
                  })
                  .catch((error: unknown) => void presentError(error)),
            },
            icon('unlock', 'me-2'),
            'Unlock',
          ),
    );
  };

  const changeCard = (): HTMLElement => {
    const current = passphraseInput({
      label: 'Current passphrase',
      autocomplete: 'current-password',
      testId: 'lock-current',
    });
    const next = passphraseInput({
      label: 'New passphrase',
      autocomplete: 'new-password',
      testId: 'lock-change-new',
      strength: true,
    });
    const confirm = passphraseInput({
      label: 'Repeat the new passphrase',
      autocomplete: 'new-password',
      testId: 'lock-change-confirm',
    });
    const submit = h(
      'button',
      { type: 'submit', class: 'btn btn-outline-primary', 'data-testid': 'lock-change' },
      'Change passphrase',
    );
    return card(
      { title: 'Change passphrase', icon: 'key', testId: 'lock-change-card' },
      h(
        'form',
        {
          class: 'vstack gap-3 or-form-narrow',
          noValidate: true,
          onsubmit: (event: Event) => {
            event.preventDefault();
            if (!current.input.value) {
              current.invalid('Enter your current passphrase.');
              current.input.focus();
              return;
            }
            if (!validNewPassphrase(next, confirm)) return;
            void busy(submit, async () => {
              try {
                await lock.changePassphrase(current.input.value, next.input.value);
                toast({ message: 'Passphrase changed.', variant: 'success' });
                for (const field of [current, next, confirm]) field.clear();
              } catch (error) {
                if (errorCode(error) === 'wrong-passphrase') {
                  current.invalid('Wrong passphrase.');
                  current.input.select();
                } else {
                  await presentError(error);
                }
              }
            });
          },
        },
        current.element,
        next.element,
        confirm.element,
        h('div', null, submit),
      ),
    );
  };

  const disableCard = (): HTMLElement => {
    const current = passphraseInput({
      label: 'Passphrase',
      autocomplete: 'current-password',
      testId: 'lock-off-passphrase',
    });
    const submit = h(
      'button',
      { type: 'submit', class: 'btn btn-outline-danger', 'data-testid': 'lock-disable' },
      'Turn off the lock',
    );
    return card(
      {
        title: 'Turn off the lock',
        icon: 'unlock',
        text: 'Your keys are decrypted and stored without a passphrase again.',
        testId: 'lock-disable-card',
      },
      h(
        'form',
        {
          class: 'vstack gap-3 or-form-narrow',
          noValidate: true,
          onsubmit: (event: Event) => {
            event.preventDefault();
            if (!current.input.value) {
              current.invalid('Enter your passphrase.');
              current.input.focus();
              return;
            }
            void busy(submit, async () => {
              try {
                await lock.disable(current.input.value);
                // These cards are replaced by the "turn on" form: focus goes to the section heading.
                render();
                focusSectionHeading('security');
                toast({ message: 'Passphrase lock is off.', variant: 'success' });
              } catch (error) {
                if (errorCode(error) === 'wrong-passphrase') {
                  current.invalid('Wrong passphrase.');
                  current.input.select();
                } else {
                  await presentError(error);
                }
              }
            });
          },
        },
        current.element,
        h('div', null, submit),
      ),
    );
  };

  const autoLock = numberField<number>({
    label: 'Auto-lock after',
    help: 'Minutes without activity before the keys lock again in a tab; 0 means never (closing the tab still locks them). At most 1,440 (a day).',
    suffix: 'minutes',
    inputMode: 'numeric',
    testId: 'auto-lock-minutes',
    className: 'or-field-narrow',
    parse: (text) => parseWhole(text, { min: 0, max: MAX_AUTO_LOCK_MINUTES }),
    onCommit: (value) =>
      saveSettings(core, (draft) => {
        draft.security.autoLockMinutes = value;
      }),
  });

  let state = '';
  /** Rebuilds the cards when the lock state changes (here, in another tab, or by auto-lock). */
  function render(): void {
    const enabled = lock.enabled();
    const next = `${enabled}|${enabled && lock.unlocked()}`;
    if (next === state) return;
    state = next;
    const cards: Child[] = enabled ? [statusCard(), changeCard(), disableCard()] : [enableCard()];
    rerender(body, cards, { fallback: () => document.getElementById('security-title') });
  }

  function focusToggle(): void {
    body.querySelector<HTMLElement>('[data-focus-key="lock:toggle"]')?.focus();
  }

  const element = h(
    'div',
    null,
    body,
    card(
      {
        title: 'Auto-lock',
        icon: 'hourglass-split',
        text: 'Applies while the passphrase lock is on.',
        testId: 'auto-lock',
      },
      autoLock.element,
    ),
    h(
      'div',
      { class: 'alert alert-warning d-flex gap-3 mb-4', 'data-testid': 'shared-origin-note' },
      icon('exclamation-triangle-fill', 'fs-5 lh-1 mt-1'),
      h(
        'div',
        null,
        h('h3', { class: 'h6 mb-1' }, 'A note on github.io'),
        'On ethanpil.github.io every project site shares one origin, so another page on that address could read what ORtoolbox stores in this browser. The lock keeps your keys encrypted there; a key with a small credit limit helps too. ',
        h('a', { class: 'alert-link', href: url('privacy/') }, 'Read more on the Privacy page'),
        '.',
      ),
    ),
  );

  core.keys.subscribe(render);
  core.settings.subscribe((nextSettings, prev) => {
    if (nextSettings.security.autoLockMinutes !== prev.security.autoLockMinutes) {
      autoLock.sync(String(nextSettings.security.autoLockMinutes));
    }
  });
  autoLock.sync(String(core.settings.get().security.autoLockMinutes));
  render();
  return { element };
}
