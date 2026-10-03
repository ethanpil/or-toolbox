import { comingSoon } from '../../ui/tool/coming-soon';
import { mountTool } from '../../ui/tool/index';
import { getTool } from '../registry';

mountTool(getTool('video-studio'), comingSoon, { isolation: 'required' });
