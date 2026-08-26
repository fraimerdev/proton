export interface HelpDeps {
  dashboardUrl?: string;
}

export const NO_DASHBOARD_URL =
  'this deployment has no usable DASHBOARD_URL, so /help cannot link to the dashboard. It must ' +
  'be a complete http:// or https:// address, and createHelpModule needs it passed in.';

export function dashboardLink(deps: HelpDeps, guildId: string): string | null {
  const base = deps.dashboardUrl?.trim().replace(/\/+$/, '');
  if (!base || !/^https?:\/\//i.test(base) || !URL.canParse(base)) return null;

  return `${base}/dashboard/${guildId}`;
}
