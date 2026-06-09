import { describe, expect, it } from 'vitest';
import { STAGE_OPTIONS } from '../../../pipeline-tracker/src/config.ts';

describe('STAGE_OPTIONS', () => {
  it('jobseeker has exactly 3 stages', () => {
    expect(STAGE_OPTIONS.jobseeker).toHaveLength(3);
    expect(STAGE_OPTIONS.jobseeker).toContain('connection_request');
    expect(STAGE_OPTIONS.jobseeker).toContain('accepted_connection');
    expect(STAGE_OPTIONS.jobseeker).toContain('direct_message');
  });

  it('fractional has exactly 8 stages (3 shared + 5 additional)', () => {
    expect(STAGE_OPTIONS.fractional).toHaveLength(8);
    // includes the jobseeker subset
    expect(STAGE_OPTIONS.fractional).toContain('connection_request');
    expect(STAGE_OPTIONS.fractional).toContain('accepted_connection');
    expect(STAGE_OPTIONS.fractional).toContain('direct_message');
    // fractional-only additions
    expect(STAGE_OPTIONS.fractional).toContain('offered_value_add');
    expect(STAGE_OPTIONS.fractional).toContain('sent_value_add');
    expect(STAGE_OPTIONS.fractional).toContain('scheduled_call');
    expect(STAGE_OPTIONS.fractional).toContain('follow_up');
    expect(STAGE_OPTIONS.fractional).toContain('no_action');
  });

  it('jobseeker is a strict subset of fractional', () => {
    for (const stage of STAGE_OPTIONS.jobseeker) {
      expect(STAGE_OPTIONS.fractional).toContain(stage);
    }
  });

  it('fractional starts with the same 3 stages in the same order as jobseeker', () => {
    expect(STAGE_OPTIONS.fractional.slice(0, 3)).toEqual([...STAGE_OPTIONS.jobseeker]);
  });
});
