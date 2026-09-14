import type { ReactElement } from 'react';
import { ProtonMark } from '../shell/topbar.tsx';
import { Button, Select, Switch } from '../ui/controls.tsx';
import { StatusBanner } from '../ui/feedback.tsx';
import { Icon, type IconName } from '../ui/icon.tsx';
import { Rows, SettingRow } from '../ui/layout.tsx';

const NAV: readonly { label: string; items: readonly { label: string; icon: IconName }[] }[] = [
  {
    label: 'Security',
    items: [
      { label: 'Automod', icon: 'shield-warning' },
      { label: 'Anti-Raid', icon: 'users-three' },
      { label: 'Anti-Nuke', icon: 'siren' },
      { label: 'Phishing', icon: 'link-break' },
      { label: 'Honeypot', icon: 'bug' },
    ],
  },
  {
    label: 'Moderation',
    items: [
      { label: 'Moderation', icon: 'gavel' },
      { label: 'Cases', icon: 'clipboard-text' },
    ],
  },
];

const ignore = (): undefined => undefined;

export function DashboardShot(): ReactElement {
  return (
    <div className="landing-dash" inert>
      <div className="landing-dash-top">
        <ProtonMark size={22} />
        Proton
        <span className="landing-dash-server">
          <span className="landing-dash-server-icon">N</span>
          Northwind
          <Icon name="caret-down" size={11} weight="fill" />
        </span>
      </div>

      <div className="landing-dash-body">
        <div className="landing-dash-nav">
          {NAV.map((group) => (
            <div className="sidebar-group" key={group.label}>
              <p className="sidebar-group-label">{group.label}</p>
              {group.items.map((item) => (
                <span
                  className="sidebar-item"
                  key={item.label}
                  aria-current={item.label === 'Honeypot' ? 'page' : undefined}
                >
                  <Icon name={item.icon} size={16} className="sidebar-item-icon" />
                  <span className="sidebar-item-label">{item.label}</span>
                </span>
              ))}
            </div>
          ))}
        </div>

        <div className="landing-dash-page">
          <div className="landing-dash-head">
            <span className="landing-dash-title">
              <Icon name="bug" size={22} />
              Honeypot
            </span>
            <Switch checked onChange={ignore} label="Honeypot" />
          </div>

          <StatusBanner
            tone="warning"
            title="Proton cannot run Honeypot"
            actions={
              <Button tone="secondary" size="sm">
                Copy reason
              </Button>
            }
          >
            I'm missing the Ban Members permission in this server.
          </StatusBanner>

          <Rows>
            <SettingRow title="Bait channels" description="Channels Honeypot watches for messages.">
              <span className="chip">
                <Icon name="hash" size={12} />
                welcome-bonus
              </span>
            </SettingRow>
            <SettingRow title="Action" description="What happens when someone triggers Honeypot.">
              <Select
                width="sm"
                value="softban"
                options={[{ value: 'softban', label: 'Softban' }]}
                onChange={ignore}
                aria-label="Action"
              />
            </SettingRow>
            <SettingRow
              title="Delete trigger message"
              description="Delete the message that triggered Honeypot."
            >
              <Switch checked onChange={ignore} label="Delete trigger message" />
            </SettingRow>
          </Rows>
        </div>
      </div>
    </div>
  );
}
