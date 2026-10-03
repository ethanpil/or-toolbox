import { mountPage } from '../ui/shell/index';
import { comingNext } from './placeholder';

mountPage(
  {
    title: 'Settings',
    icon: 'gear',
    lead: 'Keys, default models, budgets, appearance and your data.',
    nav: 'settings',
  },
  ({ main }) => {
    main.append(
      comingNext(
        'gear',
        'Keys, default models, budgets, appearance, data and backup arrive here next.',
      ),
    );
  },
);
