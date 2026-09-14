import { describe, expect, test } from 'bun:test';
import { slugify, slugTyping } from '../src/pages/tickets/shape.ts';

describe('slugTyping', () => {
  test('keeps a trailing separator so the next character can follow it', () => {
    expect(slugTyping('reply-', 32)).toBe('reply-');
    expect(slugTyping('reply.', 32)).toBe('reply.');
    expect(slugTyping('reply_', 32)).toBe('reply_');
  });

  test('lower-cases and turns a run of other characters into one dash', () => {
    expect(slugTyping('Order  Status!', 32)).toBe('order-status-');
  });

  test('keeps a leading separator for the ID check to report', () => {
    expect(slugTyping('-reply', 32)).toBe('-reply');
  });

  test('stops at the maximum length', () => {
    expect(slugTyping('abcdef', 4)).toBe('abcd');
  });
});

describe('slugify', () => {
  test('still trims separators from an ID derived from a name', () => {
    expect(slugify('Order status!', 32)).toBe('order-status');
  });
});
