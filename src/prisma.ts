import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
