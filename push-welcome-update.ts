import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  let dejavuh = await prisma.user.findFirst({
    where: {
      username: {
        equals: 'dejavuh',
        mode: 'insensitive'
      }
    }
  });

  if (!dejavuh) {
    console.log("User dejavuh not found. Creating admin user dejavuh...");
    dejavuh = await prisma.user.create({
      data: {
        username: 'dejavuh',
        email: 'dejavuh@davinci.dev',
        arisePoints: 99999,
        bio: 'Lead Developer'
      }
    });
  }

  const announcement = await prisma.announcement.create({
    data: {
      authorId: dejavuh.id,
      title: "Welcome new admin @speyvenerable! & Beta Testing Role 🎉",
      content: "We are thrilled to welcome our newest admin, **speyvenerable**, to the team! 🎉\n\nAlso, a quick update for our community: when new users join, 10 lucky users will receive a rare beta testing role! We haven't decided the name for this role yet, so if you have any cool ideas, please leave them in the comments below. Your input is highly appreciated! 👇",
      tag: "Announcements, Community",
      image: null,
    }
  });

  console.log("Successfully pushed announcement as dejavuh:", announcement.id);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
