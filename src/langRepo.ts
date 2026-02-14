import { prisma } from './prisma.ts';
import { withDbRetry } from './dbRetry.ts';

export async function upsertGroupidLanguageMapping(
  groupId: string,
  languageCode: string
) {
  await withDbRetry(() =>
    prisma.groupidLanguageMapping.upsert({
      where: { groupId },
      update: { languageCode },
      create: { groupId, languageCode },
    })
  );
}
