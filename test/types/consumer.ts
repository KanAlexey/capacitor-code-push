// Compiled by `npm run typecheck:test`, never run: the lines under @ts-expect-error must stay refused.
import { CodePush, InstallMode } from '../../src';
import type { SyncStatus } from '../../src';

export async function consumer(): Promise<SyncStatus> {
  CodePush.configure({ serverUrl: 'https://updates.example.com/', deploymentKey: 'key', debug: true });

  // @ts-expect-error onUpdateAvailable is required: a sync must decide what the user is asked.
  await CodePush.sync({});
  // @ts-expect-error so are the options that carry it.
  await CodePush.sync();

  const update = await CodePush.checkForUpdate();
  if (update) {
    await CodePush.install(
      await CodePush.download(update),
      // @ts-expect-error an install mode is one of InstallMode's values.
      { installMode: 'later' },
    );
  }

  return CodePush.sync(
    { onUpdateAvailable: () => true, installMode: InstallMode.ON_NEXT_RESUME, minimumBackgroundDuration: 60 },
    {
      onStatus: (status: SyncStatus) => status,
      onProgress: ({ totalBytes, receivedBytes }) => receivedBytes / totalBytes,
    },
  );
}
