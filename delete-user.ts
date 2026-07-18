import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const email = 'deadfool447@gmail.com';
  console.log(`Deleting user with email: ${email}`);
  
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.log(`User ${email} not found.`);
    return;
  }
  
  await prisma.user.delete({ where: { email } });
  console.log(`Successfully deleted user ${email} and all related data (cascaded).`);
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
