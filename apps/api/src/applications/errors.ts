export const APPLICATIONS_ERROR_CODES = [
  'not_found',
  'not_member',
  'not_allowed',
  'module_disabled',
  'stale',
  'conflict',
  'unavailable',
  'no_bus',
  'no_redis',
  'invalid_request',
  'unpublishable',
] as const;

export type ApplicationsErrorCode = (typeof APPLICATIONS_ERROR_CODES)[number];

export class ApplicationsError extends Error {
  readonly code: ApplicationsErrorCode;

  constructor(code: ApplicationsErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'ApplicationsError';
  }
}

export function applicationsErrorStatus(code: ApplicationsErrorCode): 400 | 404 | 409 | 503 {
  switch (code) {
    case 'not_found':
      return 404;
    case 'no_bus':
    case 'no_redis':
    case 'unavailable':
      return 503;
    case 'module_disabled':
    case 'stale':
    case 'conflict':
      return 409;
    default:
      return 400;
  }
}
