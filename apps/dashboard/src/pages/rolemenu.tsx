import { rolemenuConfigSchema } from '@proton/module-rolemenu/config';
import type { ReactElement } from 'react';
import { useCallback, useMemo } from 'react';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { ModuleLink, useModuleNavigate, useModuleSearch } from '../components/module/route.tsx';
import { useModuleToggle } from '../components/module/toggle.ts';
import { Button } from '../components/ui/controls.tsx';
import { EmptyState, LoadingBoundary, StatusBanner } from '../components/ui/feedback.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { MenuEditor } from './rolemenu/editor.tsx';
import { MenuList } from './rolemenu/list.tsx';
import { liveProblems, menuHasProblem, useMenuIndex } from './rolemenu/shape.ts';

const UNKNOWN = 'It may have been renamed or deleted.';

export default function RolemenuPage({ guildId, meta, summary }: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: rolemenuConfigSchema });
  const toggle = useModuleToggle(guildId, summary);
  const go = useModuleNavigate(guildId, meta.id);
  const search = useModuleSearch();

  const open = useCallback(
    (menuId: string | undefined, replace = false) => {
      go({ id: menuId }, { replace });
    },
    [go],
  );

  const config = form.value;
  const enabled = summary?.enabled ?? form.view.enabled;

  const index = useMenuIndex(config.menus, search.id);
  const menu = index >= 0 ? config.menus[index] : undefined;
  const view = menu !== undefined ? 'editor' : search.id !== undefined ? 'missing' : 'list';

  const problems = useMemo(() => liveProblems(config), [config]);
  const blocked = problems.size > 0;

  return (
    <>
      <ModuleHeader
        meta={meta}
        crumb={
          menu !== undefined ? (
            <span className="mono">{menu.id === '' ? 'Unnamed menu' : menu.id}</span>
          ) : undefined
        }
        backTo={
          menu !== undefined ? (
            <ModuleLink guildId={guildId} moduleId={meta.id} search={{ ...search, id: undefined }}>
              {meta.label}
            </ModuleLink>
          ) : undefined
        }
        actions={
          <ModuleSwitch
            name={meta.label}
            enabled={enabled}
            state={summary ? moduleState(summary) : 'off'}
            busy={toggle.busy}
            onToggle={toggle.toggle}
          />
        }
      />

      <ModuleBanners
        guildId={guildId}
        moduleName={meta.label}
        status={summary?.status}
        enabled={enabled}
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}
      </ModuleBanners>

      <LoadingBoundary
        key={view}
        label={view === 'editor' ? 'Loading role menu' : 'Loading role menus'}
        minHeight={320}
      >
        {menu !== undefined ? (
          <MenuEditor
            form={form}
            guildId={guildId}
            moduleId={meta.id}
            enabled={enabled}
            index={index}
            menu={menu}
            problems={problems}
            onIdSettled={(menuId) => {
              // Replaced, not pushed: Back after a rename would otherwise land on the dead old id.
              if (menuId !== '' && menuId !== search.id) open(menuId, true);
            }}
          />
        ) : search.id !== undefined ? (
          <EmptyState
            icon="warning"
            title="Role menu not found"
            inset
            actions={
              <Button tone="primary" onClick={() => open(undefined)}>
                Back to role menus
              </Button>
            }
          >
            {UNKNOWN}
          </EmptyState>
        ) : (
          <MenuList
            form={form}
            guildId={guildId}
            moduleId={meta.id}
            enabled={enabled}
            problems={problems}
            onOpen={(menuId) => open(menuId)}
          />
        )}
      </LoadingBoundary>

      <SaveBar
        dirty={form.dirty}
        saving={form.saving}
        disabled={blocked}
        note={
          blocked
            ? saveBlockedNote(
                config.menus
                  .filter((_, at) => menuHasProblem(problems, at))
                  .map((broken) => (broken.id === '' ? 'the unnamed menu' : broken.id)),
                menu?.id,
              )
            : undefined
        }
        onSave={form.save}
        onReset={form.reset}
      />
    </>
  );
}

function saveBlockedNote(broken: readonly string[], openId: string | undefined): string {
  if (broken.length === 1 && broken[0] === openId) {
    return 'Fix the marked settings before saving.';
  }
  if (broken.length === 1) return `Fix ${broken[0]} before saving.`;
  return `Fix ${broken.length} role menus before saving: ${broken.join(', ')}.`;
}
