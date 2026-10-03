import { mountPage } from '../ui/shell/index';
import { comingNext } from './placeholder';

mountPage(
  {
    title: 'History',
    icon: 'clock-history',
    lead: 'Every run across all tools, newest first.',
    nav: 'history',
  },
  ({ main }) => {
    main.append(
      comingNext(
        'clock-history',
        'A searchable timeline of your runs, with reopen and re-run, arrives here next.',
      ),
    );
  },
);
