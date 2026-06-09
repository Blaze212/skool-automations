import type { EventType } from './types.ts';

export const STAGE_OPTIONS = {
  jobseeker: ['connection_request', 'accepted_connection', 'direct_message'],
  fractional: [
    'connection_request',
    'accepted_connection',
    'direct_message',
    'offered_value_add',
    'sent_value_add',
    'scheduled_call',
    'follow_up',
    'no_action',
  ],
} as const satisfies Record<'jobseeker' | 'fractional', readonly EventType[]>;

export type ProductMode = keyof typeof STAGE_OPTIONS;
