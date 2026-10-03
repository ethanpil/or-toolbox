import { mountPage } from '../ui/shell/index';
import { comingNext } from './placeholder';

mountPage(
  {
    title: 'Models',
    icon: 'cpu',
    lead: 'Every model on OpenRouter, with prices, context and your own stats.',
    nav: 'models',
  },
  ({ main }) => {
    main.append(
      comingNext(
        'cpu',
        'The searchable model catalog with filters and comparison arrives here next.',
      ),
    );
  },
);
