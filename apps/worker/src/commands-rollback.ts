#!/usr/bin/env bun

import { HttpRestProxyClient } from '@proton/core';
import { createEnv } from '@proton/core/env';
import { createDb, DrizzleCommandRegistrationStore, guildCommandRegistrations } from '@proton/db';
import { inRegistrationScope, rollbackGuildCommands } from './command-sync.ts';
import { envSchema, registrationRefusal } from './env.ts';

const USAGE = 'usage: bun --env-file=.env apps/worker/src/commands-rollback.ts [--confirm]';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--confirm')) {
  console.error(USAGE);
  process.exit(2);
}
const confirmed = args.includes('--confirm');

const env = createEnv(
  'commands-rollback',
  envSchema.pick({
    DATABASE_URL: true,
    REST_PROXY_URL: true,
    DISCORD_APPLICATION_ID: true,
    COMMAND_REGISTRATION_SCOPE: true,
    DISCORD_TEST_GUILD_ID: true,
  }),
);

const refusal = registrationRefusal(env);
if (refusal) {
  console.error(`REFUSED: ${refusal}`);
  process.exit(2);
}

const rail = {
  applicationId: env.DISCORD_APPLICATION_ID,
  scope: env.COMMAND_REGISTRATION_SCOPE,
  testGuildId: env.DISCORD_TEST_GUILD_ID,
};

const handle = createDb(env.DATABASE_URL);

try {
  const rows = await handle.db
    .select({ guildId: guildCommandRegistrations.guildId })
    .from(guildCommandRegistrations);
  const guildIds = rows.map((row) => row.guildId).filter((id) => inRegistrationScope(rail, id));

  console.log(
    `Proton has registered commands in ${guildIds.length} server(s) (scope ${rail.scope}).`,
  );

  if (!confirmed) {
    for (const guildId of guildIds) console.log(`  would remove the commands in ${guildId}`);
    console.log(
      'Nothing was changed. Stop proton-worker first, then run again with --confirm to remove ' +
        'every per-server command and forget the records, before checking out a release that ' +
        'registers global commands.',
    );
  } else {
    const report = await rollbackGuildCommands({
      rest: new HttpRestProxyClient(env.REST_PROXY_URL),
      rail,
      guildIds,
      store: new DrizzleCommandRegistrationStore(handle),
      print: (line) => console.log(line),
    });

    console.log(
      `removed the commands in ${report.removed.length} server(s); ${report.failed.length} failed.`,
    );
    process.exitCode = report.failed.length > 0 ? 1 : 0;
  }
} finally {
  await handle.close();
}
