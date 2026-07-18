import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findUnique({
    where: { username: 'dejavuh' }
  });

  if (!user) {
    console.error("User dejavuh not found.");
    return;
  }

  const content = `## Level System & Arise Points

We've overhauled the progression system to reward active users! Here's how it works:
- **Level System**: You gain EXP by watching anime, engaging with the community, and completing specific milestones. As you level up, you unlock new customizable options for your profile.
- **Arise Points**: A new premium currency that you earn from leveling up and completing special tasks. You can use Arise Points in the upcoming shop to buy exclusive banners, badges, and effects.

## The Watcher Role

We are introducing **The Watcher** role! This is an exclusive, highly sought-after role reserved only for our earliest supporters. 
**IMPORTANT**: This role will become completely unobtainable once the beta phase of the website ends. It is a badge of honor to show you were here from the very beginning. Grab it while you can!`;

  const announcement = await prisma.announcement.create({
    data: {
      authorId: user.id,
      title: "Level System, Arise Points, and The Watcher Role",
      content,
      tag: "Platform Updates"
    }
  });
  console.log("Announcement created successfully:", announcement.id);
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
