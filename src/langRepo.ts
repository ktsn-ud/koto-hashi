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

export async function getLanguageCodeByGroupId(
  groupId: string
): Promise<string | null> {
  const record = await withDbRetry(() => {
    return prisma.groupidLanguageMapping.findUnique({
      where: { groupId },
      select: { languageCode: true },
    });
  });
  return record ? record.languageCode : null;
}
