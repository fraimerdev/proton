import type { z } from 'zod';
import { type FormConfig, formSchema } from './config.ts';

export const FORM_TEMPLATE_IDS = ['moderator', 'team', 'partnership', 'event'] as const;
export type FormTemplateId = (typeof FORM_TEMPLATE_IDS)[number];

export interface FormTemplate {
  id: FormTemplateId;
  name: string;
  summary: string;
  build(id: string): FormConfig;
}

type Draft = Omit<z.input<typeof formSchema>, 'id'>;

function option(value: string, label: string) {
  return { value, label };
}

const MODERATOR: Draft = {
  name: 'Moderator Application',
  description: 'Apply to help keep this server safe and welcoming.',
  emoji: { name: '\u{1F6E1}\u{FE0F}' },
  intro:
    'Thanks for your interest in joining the moderation team. There are no trick questions, so ' +
    'answer honestly and in your own words. It takes about ten minutes.',
  confirmation:
    'Thanks for applying. The team reads every application, and you’ll hear back once a ' +
    'decision is made.',
  sections: [
    {
      id: 'about',
      title: 'About you',
      questions: [
        {
          id: 'timezone',
          type: 'short',
          label: 'What’s your time zone?',
          placeholder: 'For example UTC+1 or Eastern Time',
          maxLength: 50,
        },
        {
          id: 'hours',
          type: 'single',
          label: 'How many hours a week could you moderate?',
          options: [
            option('under-5', 'Under 5 hours'),
            option('5-10', '5 to 10 hours'),
            option('10-20', '10 to 20 hours'),
            option('over-20', 'More than 20 hours'),
          ],
        },
        {
          id: 'why',
          type: 'paragraph',
          label: 'Why do you want to moderate here?',
          help: 'What do you enjoy about this community, and what would you like to improve?',
          minLength: 50,
          maxLength: 1500,
        },
      ],
    },
    {
      id: 'experience',
      title: 'Experience',
      questions: [
        {
          id: 'experienced',
          type: 'single',
          label: 'Have you moderated a community before?',
          options: [option('yes', 'Yes'), option('no', 'No')],
        },
        {
          id: 'experience-details',
          type: 'paragraph',
          label: 'Tell us about that experience',
          help: 'Which communities, roughly how big they were, and what you did there.',
          maxLength: 1500,
          showIf: { questionId: 'experienced', values: ['yes'] },
        },
        {
          id: 'tools',
          type: 'multiple',
          label: 'Which moderation tools have you used?',
          required: false,
          options: [
            option('automod', 'Discord AutoMod'),
            option('bots', 'Moderation bots'),
            option('audit-log', 'The audit log'),
            option('timeouts', 'Timeouts and bans'),
          ],
        },
      ],
    },
    {
      id: 'scenarios',
      title: 'Scenarios',
      description: 'There’s no single right answer. We want to see how you think things through.',
      questions: [
        {
          id: 'argument',
          type: 'paragraph',
          label: 'Handling an argument',
          help: 'Two members are arguing in a public channel and it’s getting personal. What do you do?',
          minLength: 30,
          maxLength: 1500,
        },
        {
          id: 'friend-report',
          type: 'paragraph',
          label: 'A report about a friend',
          help: 'A member reports a friend of yours for breaking the rules. How do you handle it?',
          minLength: 30,
          maxLength: 1500,
        },
      ],
    },
    {
      id: 'agreement',
      title: 'Before you send',
      questions: [
        {
          id: 'rules',
          type: 'confirm',
          label: 'I’ve read the server rules',
          help: 'Moderators are expected to follow them too.',
        },
      ],
    },
  ],
};

const TEAM: Draft = {
  name: 'Team Application',
  description: 'Apply to join the team that builds and runs this community.',
  emoji: { name: '\u{1F91D}' },
  intro:
    'We’re always glad to meet people who want to help. Tell us which role interests you and ' +
    'what you’d bring to it.',
  confirmation: 'Thanks for applying. We’ll read your application and get back to you.',
  sections: [
    {
      id: 'role',
      title: 'The role',
      questions: [
        {
          id: 'role',
          type: 'single',
          label: 'Which role are you applying for?',
          options: [
            option('developer', 'Developer'),
            option('designer', 'Designer'),
            option('writer', 'Writer'),
            option('events', 'Events'),
            option('support', 'Community support'),
          ],
        },
        {
          id: 'why',
          type: 'paragraph',
          label: 'Why are you interested in this role?',
          maxLength: 1000,
        },
      ],
    },
    {
      id: 'work',
      title: 'Your work',
      questions: [
        {
          id: 'portfolio',
          type: 'url',
          label: 'Your GitHub profile or portfolio',
          help: 'A profile or project we can look at.',
          placeholder: 'https://github.com/you',
          showIf: { questionId: 'role', values: ['developer'] },
        },
        {
          id: 'languages',
          type: 'multiple',
          label: 'Which languages do you work with?',
          options: [
            option('typescript', 'TypeScript'),
            option('python', 'Python'),
            option('rust', 'Rust'),
            option('go', 'Go'),
            option('other', 'Something else'),
          ],
          showIf: { questionId: 'role', values: ['developer'] },
        },
        {
          id: 'design-portfolio',
          type: 'url',
          label: 'Your design portfolio',
          showIf: { questionId: 'role', values: ['designer'] },
        },
        {
          id: 'writing-sample',
          type: 'url',
          label: 'A piece you’ve written',
          required: false,
          showIf: { questionId: 'role', values: ['writer'] },
        },
        {
          id: 'experience',
          type: 'paragraph',
          label: 'Relevant experience',
          help: 'Projects, teams or communities you’ve contributed to.',
          maxLength: 1500,
        },
      ],
    },
    {
      id: 'availability',
      title: 'Availability',
      questions: [
        {
          id: 'hours',
          type: 'number',
          label: 'Hours a week you can give',
          help: 'A rough estimate is fine.',
          integer: true,
          min: 1,
          max: 80,
        },
        {
          id: 'timezone',
          type: 'short',
          label: 'Your time zone',
          placeholder: 'For example UTC-5',
          maxLength: 50,
        },
      ],
    },
  ],
};

const PARTNERSHIP: Draft = {
  name: 'Partnership Request',
  description: 'Propose a partnership between your community or project and this server.',
  emoji: { name: '\u{1F517}' },
  intro:
    'Tell us about your community or project and what you have in mind. We look at every ' +
    'request and reply once we’ve talked it over.',
  confirmation: 'Thanks for reaching out. We’ll review your request and let you know.',
  sections: [
    {
      id: 'about',
      title: 'About you',
      questions: [
        {
          id: 'kind',
          type: 'single',
          label: 'What are you representing?',
          options: [
            option('server', 'A Discord server'),
            option('creator', 'A creator or channel'),
            option('project', 'A project or product'),
            option('organisation', 'An organisation'),
          ],
        },
        {
          id: 'name',
          type: 'short',
          label: 'What’s it called?',
          maxLength: 100,
        },
        {
          id: 'invite',
          type: 'url',
          label: 'Server invite link',
          help: 'A link that doesn’t expire works best.',
          placeholder: 'https://discord.gg/example',
          hosts: ['discord.gg', 'discord.com'],
          showIf: { questionId: 'kind', values: ['server'] },
        },
        {
          id: 'link',
          type: 'url',
          label: 'Website or main channel',
          showIf: { questionId: 'kind', values: ['creator', 'project', 'organisation'] },
        },
        {
          id: 'audience',
          type: 'number',
          label: 'Rough audience size',
          help: 'Members, followers or subscribers.',
          integer: true,
          min: 0,
          max: 100_000_000,
        },
      ],
    },
    {
      id: 'proposal',
      title: 'Your proposal',
      questions: [
        {
          id: 'offer',
          type: 'paragraph',
          label: 'What would you like to do together?',
          minLength: 30,
          maxLength: 1500,
        },
        {
          id: 'benefit',
          type: 'paragraph',
          label: 'What’s in it for our members?',
          maxLength: 1000,
        },
        {
          id: 'contact',
          type: 'short',
          label: 'Best way to reach you',
          help: 'Only if it isn’t this Discord account.',
          required: false,
          maxLength: 100,
        },
        {
          id: 'represent',
          type: 'confirm',
          label: 'I can speak for this community or project',
          help: 'You own or run it, or its owners know you’re asking.',
        },
      ],
    },
  ],
};

const EVENT: Draft = {
  name: 'Event Application',
  description: 'Sign up to take part in an upcoming event.',
  emoji: { name: '\u{1F39F}\u{FE0F}' },
  intro:
    'Tell us a little about how you’d like to take part so we can plan the event. Places can ' +
    'be limited, so we’ll confirm who’s in.',
  confirmation: 'Thanks for signing up. We’ll let you know whether you have a place.',
  sections: [
    {
      id: 'taking-part',
      title: 'Taking part',
      questions: [
        {
          id: 'as',
          type: 'single',
          label: 'How do you want to take part?',
          options: [
            option('player', 'As a player'),
            option('team', 'With a team'),
            option('volunteer', 'As a volunteer'),
            option('host', 'As a host or caster'),
          ],
        },
        {
          id: 'team-name',
          type: 'short',
          label: 'Team name',
          maxLength: 60,
          showIf: { questionId: 'as', values: ['team'] },
        },
        {
          id: 'team-members',
          type: 'paragraph',
          label: 'Team members',
          help: 'Your teammates’ Discord usernames, one per line.',
          maxLength: 1000,
          showIf: { questionId: 'as', values: ['team'] },
        },
        {
          id: 'helping',
          type: 'multiple',
          label: 'How could you help?',
          options: [
            option('planning', 'Setup and planning'),
            option('moderating', 'Moderating chat'),
            option('streaming', 'Streaming'),
            option('graphics', 'Graphics'),
          ],
          showIf: { questionId: 'as', values: ['volunteer'] },
        },
      ],
    },
    {
      id: 'details',
      title: 'Details',
      questions: [
        {
          id: 'level',
          type: 'single',
          label: 'Your experience level',
          options: [
            option('new', 'New to this'),
            option('some', 'Some experience'),
            option('seasoned', 'Very experienced'),
          ],
        },
        {
          id: 'days',
          type: 'multiple',
          label: 'Which days can you make?',
          options: [
            option('friday', 'Friday'),
            option('saturday', 'Saturday'),
            option('sunday', 'Sunday'),
          ],
          minChoices: 1,
        },
        {
          id: 'notes',
          type: 'paragraph',
          label: 'Anything we should know?',
          help: 'Accessibility needs, schedule clashes or anything else.',
          required: false,
          maxLength: 1000,
        },
        {
          id: 'conduct',
          type: 'confirm',
          label: 'I’ll follow the event rules',
        },
      ],
    },
  ],
};

function template(id: FormTemplateId, summary: string, draft: Draft): FormTemplate {
  return {
    id,
    name: draft.name,
    summary,
    build: (formId: string) => formSchema.parse({ ...structuredClone(draft), id: formId }),
  };
}

export const FORM_TEMPLATES: readonly FormTemplate[] = [
  template(
    'moderator',
    'Recruit moderators with questions about availability, experience and judgement.',
    MODERATOR,
  ),
  template(
    'team',
    'Staff up a team with role-specific questions, like a portfolio link for developers.',
    TEAM,
  ),
  template(
    'partnership',
    'Hear from servers, creators and projects that want to work with you.',
    PARTNERSHIP,
  ),
  template('event', 'Sign up players, teams and volunteers for an event.', EVENT),
];

export function templateFor(id: string): FormTemplate | undefined {
  return FORM_TEMPLATES.find((entry) => entry.id === id);
}
