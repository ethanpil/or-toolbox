import { mountTool } from '../../ui/tool/index';
import { getTool } from '../registry';
import { setup } from './tool';

mountTool(getTool('image-editor'), setup);
