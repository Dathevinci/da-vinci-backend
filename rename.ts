import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findFirst({ 
    where: { username: { equals: 'xhackerdevil4456', mode: 'insensitive' } } 
  });
  
  if (user) {
    await prisma.user.update({
      where: { id: user.id },
      data: { username: 'Xhackerdevil' }
    });
    console.log("Successfully renamed user xhackerdevil4456 to Xhackerdevil");
  } else {
    console.log("User xhackerdevil4456 not found in the database.");
  }
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
