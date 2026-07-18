import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Updating bios...");

  await prisma.user.updateMany({
    where: { username: { equals: "dejavuh", mode: "insensitive" } },
    data: { bio: "Lead Developer of Da Vinci. Focused on building the ultimate cinematic tracker experience. Welcome to the platform!" }
  });

  await prisma.user.updateMany({
    where: { username: { equals: "Davinci", mode: "insensitive" } },
    data: { bio: "Official Administrator of Da Vinci. Keeping the community safe and ensuring a premium experience. Welcome!" }
  });

  console.log("Bios updated successfully!");
}

main()
  .catch(e => {
    console.error(e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
