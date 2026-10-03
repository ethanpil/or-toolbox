import { mountTool } from '../../ui/tool/index';
import { getTool } from '../registry';
import { setup } from './chat';

mountTool(getTool('chat'), setup);
