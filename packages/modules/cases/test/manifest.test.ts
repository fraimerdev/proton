import { describe, expect, test } from 'bun:test';
import { type ModuleManifest, ModuleRegistry } from '@proton/core';
import * as casesConfig from '../src/config.ts';
import * as cases from '../src/index.ts';

const { casesModule } = cases;

describe('cases manifest', () => {
  test('declares at least one permission and a non-privileged intent', () => {
    expect(casesModule.requiredPermissions.length).toBeGreaterThan(0);
    expect(casesModule.requiredIntents.length).toBeGreaterThan(0);
  });

  test('registers cleanly, drawing its form straight from the config schema', () => {
    const registry = new ModuleRegistry();
    registry.register(casesModule as ModuleManifest);

    expect(registry.descriptors(casesModule.id).map((d) => d.path)).toEqual(['enabled']);
  });

  test('ships no escalation: the ladder and the rules it compiles belong to moderation', () => {
    expect(casesModule.formSchema).toBeUndefined();
    expect(casesModule.rules).toBeUndefined();
    expect(casesModule.compileRules).toBeUndefined();
    expect(casesModule.dashboard?.sections.map((s) => s.id)).toEqual(['general']);
  });

  test('exports none of the escalation names, from either entry point', () => {
    const exported = [...Object.keys(cases), ...Object.keys(casesConfig)];

    for (const name of [
      'ESCALATION_ACTIONS',
      'escalationRungSchema',
      'escalationLadderSchema',
      'escalationRules',
      'escalationRuleId',
      'casesPresetRules',
      'casesFormSchema',
    ]) {
      expect(exported).not.toContain(name);
    }
  });
});
