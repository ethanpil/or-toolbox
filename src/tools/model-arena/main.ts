import { mountTool } from '../../ui/tool/index';
import { getTool } from '../registry';
import { setup } from './arena';

// The manifest says `ownModels`: the contenders are the models, so the header shows no model chip.
mountTool(getTool('model-arena'), setup);
