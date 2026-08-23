import type { ActionExecutor, ActionKind, ModuleRegistry } from '@proton/core';

export class UndeclaredActionError extends Error {
  constructor(moduleId: string, kind: ActionKind) {
    super(
      `The '${moduleId}' module tried to execute a '${kind}' action, which it does not declare in ` +
        "its manifest's `actionKinds` array. Add it there if the module should be able to execute " +
        'it — that array is what the bot invite asks Discord for, so a kind missing from it is a ' +
        'permission no guild ever granted and an action that fails its precheck in every server.',
    );
    this.name = 'UndeclaredActionError';
  }
}

export function moduleExecutor(
  registry: ModuleRegistry,
  moduleId: string,
  executor: ActionExecutor,
): ActionExecutor {
  return {
    execute(request) {
      if (!registry.mayExecute(moduleId, request.kind)) {
        throw new UndeclaredActionError(moduleId, request.kind);
      }
      return executor.execute(request);
    },
  };
}
