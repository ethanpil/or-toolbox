/**
 * Starter templates: ready-made question sets to load into the builder. They are read-only: `templateQuestions()`
 * hands out a deep copy, so editing the form never changes a template (the originals are frozen as well).
 * The ticket triage one is the Jev tutorial's own example (docs/openrouter-api.md §8.1).
 */
import { DEFAULT_THRESHOLD, type QuestionDef } from './schema';

export interface Template {
  id: string;
  name: string;
  description: string;
  questions: readonly QuestionDef[];
  /** A situation to try it on (the onboarding sample uses the first template's). */
  sample: string;
}

const question = (
  parts: Partial<QuestionDef> & Pick<QuestionDef, 'name' | 'id' | 'instructions' | 'type'>,
): QuestionDef => ({
  threshold: DEFAULT_THRESHOLD,
  yes: '',
  no: '',
  options: [
    { name: '', description: '' },
    { name: '', description: '' },
  ],
  levels: ['', ''],
  ...parts,
});

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const TEMPLATES: readonly Template[] = deepFreeze([
  {
    id: 'ticket-triage',
    name: 'Ticket triage',
    description: 'Is it a bug, which team owns it, how urgent is it.',
    sample:
      'Customer tier: enterprise\n\nMy checkout page shows a blank screen after I click Pay. I have tried two browsers.',
    questions: [
      question({
        name: 'Is it a bug?',
        id: 'is_bug',
        instructions: 'Is the customer reporting a software defect?',
        type: 'noul',
        yes: 'The customer describes broken or unexpected product behavior.',
        no: 'The customer is asking a question or requesting a feature.',
      }),
      question({
        name: 'Owning team',
        id: 'team',
        instructions: 'Which team should own this ticket?',
        type: 'choice',
        options: [
          { name: 'payments', description: 'Checkout, billing, or payment processing issues.' },
          {
            name: 'frontend',
            description: 'Rendering, layout, or browser compatibility issues.',
          },
          { name: 'account', description: 'Login, permissions, or profile issues.' },
        ],
      }),
      question({
        name: 'Urgency',
        id: 'urgency',
        instructions: 'How urgent is this ticket?',
        type: 'score',
        levels: [
          'Can wait for the next release',
          'Should be fixed this week',
          'Blocking revenue right now',
        ],
      }),
    ],
  },
  {
    id: 'approve-escalate',
    name: 'Approve or escalate',
    description: 'Approve a request, send it up, or decline it, and how risky it is.',
    sample:
      'Request: refund of $480 for an annual plan, asked for 41 days after purchase.\nCustomer: three years with us, no earlier refunds.\nPolicy: refunds within 30 days are automatic; later ones need a manager.',
    questions: [
      question({
        name: 'Approve as is?',
        id: 'approve',
        instructions: 'Can this request be approved without anyone else looking at it?',
        type: 'noul',
        yes: 'It is complete, within policy and low risk.',
        no: 'It breaks policy, lacks information or carries notable risk.',
      }),
      question({
        name: 'Next step',
        id: 'next_step',
        instructions: 'What should happen to this request?',
        type: 'choice',
        options: [
          { name: 'approve', description: 'Approve it as requested.' },
          { name: 'escalate', description: 'Send it to a manager or a specialist.' },
          { name: 'decline', description: 'Turn it down.' },
        ],
      }),
      question({
        name: 'Risk',
        id: 'risk',
        instructions: 'How risky is it to approve this request?',
        type: 'score',
        levels: [
          'Routine, nothing unusual',
          'Some unusual details worth a second look',
          'Clear warning signs',
        ],
      }),
    ],
  },
  {
    id: 'content-review',
    name: 'Content review',
    description: 'Does a post break the rules, what is wrong with it, how serious is it.',
    sample:
      'Post: "Everyone who disagrees with me is an idiot. Buy my course at bit.ly/xyz, it fixes everything, guaranteed."',
    questions: [
      question({
        name: 'Breaks the rules?',
        id: 'breaks_rules',
        instructions: 'Does this content break the community guidelines?',
        type: 'noul',
        yes: 'It contains harassment, spam, misleading claims or other prohibited material.',
        no: 'It is acceptable as it stands.',
      }),
      question({
        name: 'Main concern',
        id: 'concern',
        instructions: 'What is the main problem with this content, if any?',
        type: 'choice',
        options: [
          { name: 'none', description: 'Nothing to flag.' },
          { name: 'spam', description: 'Ads, scams or repeated posts.' },
          { name: 'harassment', description: 'Attacks or insults aimed at a person or a group.' },
          { name: 'misinformation', description: 'Claims that are false or misleading.' },
        ],
      }),
      question({
        name: 'Severity',
        id: 'severity',
        instructions: 'How serious is the problem?',
        type: 'score',
        levels: [
          'Harmless',
          'Mild: worth a note to the author',
          'Serious: remove soon',
          'Severe: remove now',
        ],
      }),
    ],
  },
]);

export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

/** A copy of a template's questions that the form may edit freely. */
export function templateQuestions(id: string): QuestionDef[] | null {
  const template = templateById(id);
  return template ? (JSON.parse(JSON.stringify(template.questions)) as QuestionDef[]) : null;
}
