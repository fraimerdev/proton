import { describe, expect, test } from 'bun:test';
import { MESSAGE_LOG_RETENTION_DAYS } from '@proton/module-logging';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrivacyPolicy } from '../src/components/legal/privacy-policy.tsx';

const html = renderToStaticMarkup(<PrivacyPolicy />);

describe('the privacy policy says what the code does', () => {
  test('names Proton’s operator as the data controller under GDPR and the DSA', () => {
    expect(html).toContain('data controller');
    expect(html).toContain('GDPR');
    expect(html).toContain('Digital Services Act');
  });

  test('states the retention window the logging module actually enforces', () => {
    expect(MESSAGE_LOG_RETENTION_DAYS).toBe(30);
    expect(html).toContain(`${MESSAGE_LOG_RETENTION_DAYS} days`);
  });

  test('describes what message logging stores, including the content itself', () => {
    expect(html).toContain('message, channel and server ids');
    expect(html).toContain('author');

    expect(html).toMatch(/message <strong>text<\/strong>/);
  });

  test('says message logging is off until a server admin opts in', () => {
    expect(html).toContain('off unless a server admin turns it on');
  });

  test('covers the other categories Proton stores about a person', () => {
    for (const disclosure of [
      'Moderation cases',
      'Dashboard audit trail',
      'hash of the IP address',
      'Discord user id',
    ]) {
      expect(html).toContain(disclosure);
    }
  });

  test('explains the one erasure limit rather than promising deletion it will not do', () => {
    expect(html).toContain('may be retained against');
    expect(html).toContain('legitimate interest');
  });
});
