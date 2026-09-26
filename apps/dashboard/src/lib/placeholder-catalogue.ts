import type { PlaceholderSurface } from '@proton/core/placeholders';
import { useEffect, useState } from 'react';

export interface PlaceholderCatalogue {
  whereKeyWorks(key: string): string[];
}

type Loader = () => Promise<Record<string, unknown>>;

export const PLACEHOLDER_MODULES: Readonly<Record<string, Loader>> = {
  achievements: () => import('@proton/module-achievements/placeholders'),
  appeals: () => import('@proton/module-appeals/placeholders'),
  applications: () => import('@proton/module-applications/placeholders'),
  counters: () => import('@proton/module-counters/placeholders'),
  giveaways: () => import('@proton/module-giveaways/placeholders'),
  honeypot: () => import('@proton/module-honeypot/placeholders'),
  leveling: () => import('@proton/module-leveling/placeholders'),
  messages: () => import('@proton/module-messages/placeholders'),
  moderation: () => import('@proton/module-moderation/placeholders'),
  tempvc: () => import('@proton/module-tempvc/placeholders'),
  tickets: () => import('@proton/module-tickets/placeholders'),
  welcome: () => import('@proton/module-welcome/placeholders'),
};

function isSurface(value: unknown): value is PlaceholderSurface<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'registry' in value &&
    'fields' in value &&
    'label' in value &&
    'id' in value
  );
}

function surfacesOf(exported: Record<string, unknown>): PlaceholderSurface<unknown>[] {
  return Object.values(exported).flatMap((value): PlaceholderSurface<unknown>[] => {
    if (isSurface(value)) return [value];
    if (typeof value !== 'object' || value === null || !('surfaces' in value)) return [];

    const { surfaces } = value;
    return typeof surfaces === 'object' && surfaces !== null
      ? Object.values(surfaces).filter(isSurface)
      : [];
  });
}

export function catalogueFrom(modules: readonly Record<string, unknown>[]): PlaceholderCatalogue {
  const byId = new Map<string, PlaceholderSurface<unknown>>();
  for (const surface of modules.flatMap(surfacesOf)) byId.set(surface.id, surface);
  const surfaces = [...byId.values()];

  return {
    whereKeyWorks(key) {
      return [
        ...new Set(
          surfaces
            .filter((surface) => surface.registry.resolve(key) !== undefined)
            .map((surface) => surface.label),
        ),
      ];
    },
  };
}

let loading: Promise<PlaceholderCatalogue> | undefined;
let loaded: PlaceholderCatalogue | null = null;

export function loadPlaceholderCatalogue(): Promise<PlaceholderCatalogue> {
  loading ??= Promise.all(Object.values(PLACEHOLDER_MODULES).map((load) => load())).then(
    (modules) => {
      loaded = catalogueFrom(modules);
      return loaded;
    },
  );
  return loading;
}

export function usePlaceholderCatalogue(needed: boolean): PlaceholderCatalogue | null {
  const [catalogue, setCatalogue] = useState<PlaceholderCatalogue | null>(loaded);

  useEffect(() => {
    if (!needed || catalogue !== null) return;

    let live = true;
    loadPlaceholderCatalogue().then(
      (next) => {
        if (live) setCatalogue(next);
      },
      () => undefined,
    );

    return () => {
      live = false;
    };
  }, [needed, catalogue]);

  return catalogue;
}
