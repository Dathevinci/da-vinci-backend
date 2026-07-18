import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const hashedPassword = await bcrypt.hash('dejavuh', 10);
  
  const user = await prisma.user.updateMany({
    where: { username: { equals: 'dejavuh', mode: 'insensitive' } },
    data: { password: hashedPassword },
  });

  console.log(`Updated ${user.count} user(s). Password for dejavuh set to 'dejavuh'`);
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
