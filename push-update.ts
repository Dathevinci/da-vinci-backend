import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  let davinci = await prisma.user.findFirst({
    where: {
      username: {
        equals: 'Davinci',
        mode: 'insensitive'
      }
    }
  });

  if (!davinci) {
    console.log("User Davinci not found. Creating admin user Davinci...");
    davinci = await prisma.user.create({
      data: {
        username: 'Davinci',
        email: 'admin@davinci.dev',
        arisePoints: 99999,
        avatar: 'https://i.imgur.com/Gz4B5p0.png', // A generic cool avatar or logo
        bio: 'The architect of Da Vinci.'
      }
    });
  }

  const announcement = await prisma.announcement.create({
    data: {
      authorId: davinci.id,
      title: "Interactive Leveling System is Live! 📈",
      content: "Hello everyone! We are extremely excited to announce a massive new feature to reward our most dedicated users: **The Da Vinci Leveling System**.\n\n✨ **What's New?**\n- **Dynamic Leveling:** You now have a Level based on your Arise Points (XP). The more you use the platform, the higher you climb. Note that it gets exponentially harder to level up!\n- **Watch to Earn:** You now earn +5 XP every time you start watching an episode!\n- **Finished Bonus:** Setting a show to `FINISHED` in your Watchlist grants a massive +50 XP bonus.\n- **New Badges & Progress Bars:** Check out your profile to see your glowing Level Badge and a real-time Progress Bar showing exactly how much XP you need for the next level.\n\nTime to binge some anime and level up! Enjoy the climb. 🚀",
      tag: "Platform Updates, New Features",
      image: null,
    }
  });

  console.log("Successfully pushed final announcement as Davinci:", announcement.id);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
