import { renderCaptcha } from '@proton/cards';
import type { GuildStateStore } from '@proton/core';
import type { CaptchaStore, PanelStore, QuarantineStore } from './store.ts';

export interface CaptchaRenderInput {
  text: string;
}

export type CaptchaRenderer = (input: CaptchaRenderInput) => Promise<Uint8Array>;

export interface VerificationDeps {
  guildState?: GuildStateStore;

  fetchMemberRoles?(guildId: string, userId: string): Promise<string[] | null>;

  quarantine?: QuarantineStore;

  captcha?: CaptchaStore;

  panel?: PanelStore;

  applicationId?: string;

  renderCaptcha?: CaptchaRenderer;

  verifyLinkSecret?: string;

  verifyLinkBaseUrl?: string;

  now?(): number;
}

export interface BoundGateDeps {
  guildState: GuildStateStore;
}

export interface BoundQuarantineDeps extends BoundGateDeps {
  fetchMemberRoles(guildId: string, userId: string): Promise<string[] | null>;
  quarantine: QuarantineStore;
  now(): number;
}

export interface BoundPressDeps extends BoundGateDeps {
  applicationId: string;
  now(): number;
}

export interface BoundCaptchaDeps extends BoundPressDeps {
  captcha: CaptchaStore;
  renderCaptcha: CaptchaRenderer;
}

export interface BoundWebsiteDeps extends BoundPressDeps {
  verifyLinkSecret: string;
  verifyLinkBaseUrl: string;
}

export interface BoundPanelDeps {
  panel: PanelStore;
}

export type BindResult<T> = { deps: T } | { unbound: string[] };

const PORT_HINTS: Record<string, string> = {
  guildState: 'guildState: new RedisGuildStateStore(redis)',
  fetchMemberRoles: 'fetchMemberRoles: the same single-member lookup resolvePrecheckContext uses',
  quarantine: 'quarantine: new RedisQuarantineStore(redis)',
  captcha: 'captcha: new RedisCaptchaStore(redis)',
  panel: 'panel: new RedisPanelStore(redis)',
  applicationId: "applicationId: the application's own id, from READY",
  verifyLinkSecret: 'verifyLinkSecret: env.VERIFY_LINK_SECRET',
  verifyLinkBaseUrl: 'verifyLinkBaseUrl: env.DASHBOARD_URL',
};

function missing(deps: VerificationDeps, ports: readonly (keyof VerificationDeps)[]): string[] {
  return ports.filter((port) => !deps[port]);
}

export function bindGateDeps(deps: VerificationDeps): BindResult<BoundGateDeps> {
  return deps.guildState ? { deps: { guildState: deps.guildState } } : { unbound: ['guildState'] };
}

export function bindQuarantineDeps(deps: VerificationDeps): BindResult<BoundQuarantineDeps> {
  const { guildState, fetchMemberRoles, quarantine } = deps;

  const unbound = missing(deps, ['guildState', 'fetchMemberRoles', 'quarantine']);
  if (!guildState || !fetchMemberRoles || !quarantine) return { unbound };

  return {
    deps: { guildState, fetchMemberRoles, quarantine, now: deps.now ?? (() => Date.now()) },
  };
}

export function bindPressDeps(deps: VerificationDeps): BindResult<BoundPressDeps> {
  const { guildState, applicationId } = deps;

  const unbound = missing(deps, ['guildState', 'applicationId']);
  if (!guildState || !applicationId) return { unbound };

  return { deps: { guildState, applicationId, now: deps.now ?? (() => Date.now()) } };
}

export function bindCaptchaDeps(deps: VerificationDeps): BindResult<BoundCaptchaDeps> {
  const press = bindPressDeps(deps);
  const { captcha } = deps;

  const unbound = [...('unbound' in press ? press.unbound : []), ...missing(deps, ['captcha'])];

  if ('unbound' in press || !captcha) return { unbound };

  return { deps: { ...press.deps, captcha, renderCaptcha: deps.renderCaptcha ?? renderCaptcha } };
}

export function bindWebsiteDeps(deps: VerificationDeps): BindResult<BoundWebsiteDeps> {
  const press = bindPressDeps(deps);
  const { verifyLinkSecret, verifyLinkBaseUrl } = deps;

  const unbound = [
    ...('unbound' in press ? press.unbound : []),
    ...missing(deps, ['verifyLinkSecret', 'verifyLinkBaseUrl']),
  ];

  if ('unbound' in press || !verifyLinkSecret || !verifyLinkBaseUrl) return { unbound };

  return { deps: { ...press.deps, verifyLinkSecret, verifyLinkBaseUrl } };
}

export function bindPanelDeps(deps: VerificationDeps): BindResult<BoundPanelDeps> {
  return deps.panel ? { deps: { panel: deps.panel } } : { unbound: ['panel'] };
}

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `${what} — the verification module was built without ${unbound.join(', ')}. ` +
    'The process running modules must call createVerificationModule({ ' +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}
