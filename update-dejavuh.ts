import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.user.updateMany({
    where: {
      username: {
        equals: 'Dejavuh',
        mode: 'insensitive'
      }
    },
    data: {
      arisePoints: 1000000
    }
  });
  console.log("Updated Dejavuh's arise points:", result);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
