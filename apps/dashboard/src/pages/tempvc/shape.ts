import type {
  OwnerControl,
  PrivacyMode,
  TempVcConfig,
  TempVcHub,
} from '@proton/module-tempvc/config';
import type { ModuleForm } from '../../components/module/form.ts';

export type TempVcForm = ModuleForm<TempVcConfig>;

// Mirrors PANEL_LAYOUT in the module's interface.ts — the order and clustering an owner actually
// sees on the panel buttons. interface.ts is not an exported subpath, so it is restated here.
export const PANEL_GROUPS: readonly { label: string; controls: readonly OwnerControl[] }[] = [
  { label: 'Channel', controls: ['rename', 'limit', 'privacy', 'region'] },
  { label: 'Members', controls: ['trust', 'block', 'invite', 'kick'] },
  { label: 'Ownership', controls: ['claim', 'transfer', 'delete'] },
];

export const PRIVACY_SHORT: Record<PrivacyMode, string> = {
  public: 'Public',
  locked: 'Locked',
  private: 'Private',
};

export const DUPLICATE_HUB =
  'each creator channel can only be listed once — the second entry would never be used.';

export function updateHub(
  form: TempVcForm,
  index: number,
  change: (hub: TempVcHub) => TempVcHub,
): void {
  form.setValue((current) => ({
    ...current,
    hubs: current.hubs.map((hub, at) => (at === index ? change(hub) : hub)),
  }));
}

export function setHubs(form: TempVcForm, hubs: readonly TempVcHub[]): void {
  form.setValue((current) => ({ ...current, hubs: [...hubs] }));
}
