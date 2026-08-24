export const DEFAULT_CALLBACK = '/dashboard';

// A single leading slash and nothing that could be read as a host. '//evil.example',
// '/\evil.example' and 'https://evil.example' are all valid values of `redirect` and all leave
// this site, carrying a freshly minted session cookie with them.
export function callbackFor(url: string): string {
  const requested = new URL(url, 'http://localhost').searchParams.get('redirect');

  return requested && /^\/[^/\\]/.test(requested) ? requested : DEFAULT_CALLBACK;
}
