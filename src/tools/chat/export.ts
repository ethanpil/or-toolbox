/**
 * Export of a thread's active path: Markdown (also what "Copy conversation" copies) and JSON. Attachments are
 * listed by name; their bytes are never exported. The JSON form is the linear one `parseThread` also reads.
 */
import type { AttachmentRef } from '../../core/attachments/attachments';
import { activePath, type ChatNode, type Thread } from './thread';

const attachmentLine = (refs: readonly AttachmentRef[]): string =>
  `_Attachments: ${refs.map((ref) => ref.name).join(', ')}_`;

function replyHeading(node: ChatNode): string {
  const model = node.servedModel ?? node.model;
  return model ? `## Assistant (${model})` : '## Assistant';
}

export function toMarkdown(thread: Thread): string {
  const parts: string[] = [`# ${thread.title}`];
  if (thread.system.trim()) parts.push(`**System prompt:**\n\n${thread.system.trim()}`);
  for (const node of activePath(thread)) {
    if (node.role === 'user') {
      parts.push('## You');
      if (node.content) parts.push(node.content);
      if (node.attachments?.length) parts.push(attachmentLine(node.attachments));
    } else {
      parts.push(replyHeading(node));
      if (node.content) parts.push(node.content);
      if (node.status === 'stopped') parts.push('_(stopped)_');
      if (node.status === 'error') parts.push(`_(failed: ${node.error ?? 'error'})_`);
    }
  }
  return `${parts.join('\n\n')}\n`;
}

export interface ExportedMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  model?: string;
  attachments?: { name: string; type: string; size: number }[];
  usage?: ChatNode['usage'];
  status?: ChatNode['status'];
}

export interface ExportedThread {
  id: string;
  title: string;
  system: string;
  createdAt: number;
  updatedAt: number;
  messages: ExportedMessage[];
}

export function toJson(thread: Thread): ExportedThread {
  return {
    id: thread.id,
    title: thread.title,
    system: thread.system,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messages: activePath(thread).map((node) => {
      const message: ExportedMessage = {
        role: node.role,
        content: node.content,
        createdAt: node.createdAt,
      };
      const model = node.servedModel ?? node.model;
      if (model) message.model = model;
      if (node.attachments?.length) {
        message.attachments = node.attachments.map(({ name, type, size }) => ({
          name,
          type,
          size,
        }));
      }
      if (node.usage) message.usage = node.usage;
      if (node.role === 'assistant' && node.status && node.status !== 'done') {
        message.status = node.status;
      }
      return message;
    }),
  };
}
