import { boot } from '../../core/boot';
import { renderToolStub } from '../../ui/stub';
import { getTool } from '../registry';

boot();
renderToolStub(getTool('bot-to-bot'));
