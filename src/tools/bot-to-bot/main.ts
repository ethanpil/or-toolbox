import { mountTool } from '../../ui/tool/index';
import { getTool } from '../registry';
import { setup } from './tool';

// The manifest says `ownModels`: each bot has its own model picker, so the header shows no model chip.
mountTool(getTool('bot-to-bot'), setup);
