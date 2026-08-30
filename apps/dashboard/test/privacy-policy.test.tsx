import { describe, expect, test } from 'bun:test';
import { MESSAGE_CACHE_FALLBACK_TTL_MS, MESSAGE_LOG_RETENTION_DAYS } from '@proton/module-logging';
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

  test('discloses the branding images an admin uploads, and what they are used for', () => {
    expect(html).toContain('Branding images');
    expect(html).toContain('uploaded');
    expect(html).toContain('until the image is replaced, cleared, or Proton leaves the server');
  });

  test('does not claim images are never stored now that branding stores them', () => {
    // The old sentence was scoped to message logging but read as a flat denial, and branding makes
    // it false to anyone who reads it that way.
    expect(html).not.toContain('Attachments, images and voice are never stored.');
    expect(html).toContain('the only images');
  });

  test('explains the one erasure limit rather than promising deletion it will not do', () => {
    expect(html).toContain('may be retained against');
    expect(html).toContain('legitimate interest');
  });

  // The privileged-intent application tells Discord this address; a policy that stops naming it
  // makes that answer false at the one link a reviewer opens.
  test('names the address a deletion request goes to', () => {
    expect(html).toContain('mailto:hello@fraimer.dev');
    expect(html).toContain('30 days');
  });
});

describe('the message-content cache and server logs are disclosed separately', () => {
  test('discloses the short-lived cache, its own opt-in, and that it is memory only', () => {
    expect(MESSAGE_CACHE_FALLBACK_TTL_MS / 3_600_000).toBe(24);

    expect(html).toContain('Remember recent message text');
    expect(html).toContain('<strong>24 hours</strong>');
    expect(html).toContain('in memory');
    expect(html).toContain('second, independent');
  });

  test('says switching the cache off deletes rather than waiting for expiry', () => {
    expect(html).toContain('deletes the server’s remembered text immediately');
  });

  test('discloses that log embeds copy personal data into a channel Proton does not control', () => {
    expect(html).toContain('log channel');
    expect(html).toContain('visible to anyone who can read that channel');
    expect(html).toContain('neither controls it nor can revoke it');
  });

  test('is honest that deleting from Proton does not unpost an embed', () => {
    expect(html).toContain('does not delete embeds already posted');
  });
});
