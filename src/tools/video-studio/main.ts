import { boot } from '../../core/boot';
import { renderToolStub } from '../../ui/stub';
import { getTool } from '../registry';

boot({ isolation: 'required' });
renderToolStub(getTool('video-studio'));
