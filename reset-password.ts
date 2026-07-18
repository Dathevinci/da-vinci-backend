import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const hashedPassword = await bcrypt.hash('Admin123!', 10);
  
  const user = await prisma.user.findFirst({
    where: { username: { equals: 'Xhackerdevil', mode: 'insensitive' } }
  });

  if (!user) {
    console.log('User not found!');
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { password: hashedPassword }
  });

  console.log('Successfully updated password for Xhackerdevil to Admin123!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
