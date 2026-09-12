import { describe, expect, test } from 'bun:test';
import type { Postable } from '@proton/core';
import type { ModuleForm } from '../src/components/module/form.ts';
import { postBlocked } from '../src/components/module/post-panel.tsx';

type Form = Pick<ModuleForm, 'dirty' | 'summary'>;

function form(overrides: { dirty?: boolean; enabled?: boolean } = {}): Form {
  return {
    dirty: overrides.dirty ?? false,
    summary: { name: 'Verification', enabled: overrides.enabled ?? true },
  } as Form;
}

const PANEL: Postable = {
  id: 'panel',
  name: 'Verification panel',
  channelId: '700000000000000001',
};

describe('whether the post button may be pressed', () => {
  test('lets a saved, enabled, channelled panel through', () => {
    expect(postBlocked(form(), PANEL)).toBeNull();
  });

  // The worker reads the stored config, not the page. Posting over an unsaved edit publishes the
  // last save and reads as the button ignoring what is on screen.
  test('asks for a save first, ahead of every other reason', () => {
    expect(postBlocked(form({ dirty: true }), undefined)).toContain('Save first');
    expect(postBlocked(form({ dirty: true, enabled: false }), PANEL)).toContain('Save first');
  });

  test('says the module is off, and names it', () => {
    expect(postBlocked(form({ enabled: false }), PANEL)).toContain('Verification is switched off');
  });

  test('says there is nothing to post when the panel is not in the saved config', () => {
    expect(postBlocked(form(), undefined)).toContain('nothing to post');
  });

  test('asks for a channel when the panel has none yet', () => {
    expect(postBlocked(form(), { id: 'panel', name: 'Verification panel' })).toContain(
      'Pick a channel',
    );
  });

  // A postable whose channel is '' rather than absent is the shape a half-filled editor row has.
  test('treats an empty channel as no channel, not as a channel called nothing', () => {
    expect(postBlocked(form(), { ...PANEL, channelId: '' })).toContain('Pick a channel');
  });
});
