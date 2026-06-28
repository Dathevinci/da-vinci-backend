import { prisma } from "../lib/prisma";

export const getCache = async (key: string): Promise<any | null> => {
  const cached = await prisma.cacheItem.findUnique({
    where: { key },
  });

  if (!cached) return null;

  // Check if expired
  if (new Date() > cached.expiresAt) {
    await prisma.cacheItem.delete({ where: { key } });
    return null;
  }

  try {
    return JSON.parse(cached.data);
  } catch {
    return null;
  }
};

export const setCache = async (key: string, data: any, ttlSeconds: number): Promise<void> => {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const dataString = JSON.stringify(data);

  await prisma.cacheItem.upsert({
    where: { key },
    update: { data: dataString, expiresAt },
    create: { key, data: dataString, expiresAt },
  });
};
