import { mountTool } from '../../ui/tool/index';
import { getTool } from '../registry';
import { setup } from './arena';

// The contenders are the models: the header shows no model chip of its own.
mountTool(getTool('model-arena'), setup, { modelChip: false });
