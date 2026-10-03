import { mountPage } from '../ui/shell/index';
import { comingNext } from './placeholder';

mountPage(
  {
    title: 'Stats',
    icon: 'bar-chart',
    lead: 'Spend, requests and tokens, computed from this browser’s history.',
    nav: 'stats',
  },
  ({ main }) => {
    main.append(comingNext('bar-chart', 'Charts of spend, usage and budgets arrive here next.'));
  },
);
