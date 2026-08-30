import type { AutomodConfig } from '@proton/module-automod/config';
import { planNativeRules, RULE_NAMES } from '@proton/module-automod/native';
import type { ReactElement } from 'react';

export interface EnforcementPanelProps {
  config: AutomodConfig;
}

const TRIGGER_LABELS: Record<string, string> = {
  [RULE_NAMES.keywords]: 'Blocked words and patterns',
  [RULE_NAMES.presets]: 'Discord’s maintained word lists',
  [RULE_NAMES.mentions]: 'Mention limit',
  [RULE_NAMES.spam]: 'Discord’s spam filter',
};

// The panel that keeps "one config, Proton routes" honest: the admin writes one list of things to
// block and cannot otherwise tell which half of it Discord runs at its edge and which half Proton
// runs after the message is already posted.
export function EnforcementPanel({ config }: EnforcementPanelProps): ReactElement {
  const plan = planNativeRules(config);

  return (
    <div className="enforcement" data-path="__enforcement">
      <p className="field-description">
        Everything Discord’s own AutoMod can enforce is pushed to it, so those messages are blocked
        before they are ever posted. Proton enforces the rest itself, after the fact.
      </p>

      <h3>Discord blocks these before anyone sees them</h3>
      {plan.desired.length === 0 ? (
        <p className="field-description">
          Nothing yet — fill in blocked words, a word preset, a mention limit or the spam filter.
        </p>
      ) : (
        <ul className="enforcement-list">
          {plan.desired.map((rule) => (
            <li key={rule.name}>
              <strong>{TRIGGER_LABELS[rule.name] ?? rule.name}</strong>
              <span className="enforcement-detail">{describe(rule.name)}</span>
            </li>
          ))}
        </ul>
      )}

      {plan.inHousePatterns.length > 0 ? (
        <>
          <h3>Proton runs these itself</h3>
          <ul className="enforcement-list">
            {plan.inHousePatterns.map((note) => (
              <li key={note.pattern}>
                <code>{note.pattern}</code>
                <span className="enforcement-detail">{note.reason}.</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <p className="field-description">
        Proton manages only the rules it created. A rule you built yourself in Discord’s own
        settings is never edited or removed — but editing one of Proton’s there is undone the next
        time this page is saved. Switching the module off takes them down.
      </p>
    </div>
  );
}

function describe(name: string): string {
  if (name === RULE_NAMES.keywords) return 'One keyword rule carries every word and pattern.';
  if (name === RULE_NAMES.presets) return 'Your allowed words are exceptions to it.';
  if (name === RULE_NAMES.mentions) return 'Counted by Discord, before the message is posted.';
  return 'Discord’s own heuristic, with nothing here to tune.';
}
