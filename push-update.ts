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
    // Deliberately do NOT create the account. This used to auto-create a
    // 'Davinci' user with role LEAD_DEV — minting a SECOND lead dev (full
    // moderation + free everything) as a side effect of publishing a dev blog,
    // and handing that power to whoever happened to hold the name.
    console.error("Author account 'Davinci' not found — create it first, then re-run. Aborting.");
    return;
  }

  const announcement = await prisma.announcement.create({
    data: {
      authorId: davinci.id,
      title: "Dev Blog 1.6: Manhwa Mode Evolution",
      content: "We just rolled out a massive quality of life update for the Manhwa reader!\n\n**Visual Upgrades**\n- Added incredibly smooth page transitions across all of Manhwa Mode using Framer Motion.\n- The Manhwa grid cards now smoothly cascade in.\n- Chapter images in the reader now beautifully fade in as you scroll down, eliminating jarring pop-ins.\n\n**Bug Fixes & Polish**\n- Fixed the infamous bug where clicking \"All Comics\" opened up the Anime modal for Transformers (The Anime Provider was intercepting the URL param!).\n- Manhwa ratings are now strictly formatted to 1 decimal place everywhere.\n- The mobile floating bottom navigation now properly hides itself completely when you enter fullscreen reading mode, ensuring a true 100% distraction-free experience.\n\nRefresh your page to experience the magic! 📖✨",
      tag: "Platform Updates",
      image: null,
    }
  });

  console.log("Successfully pushed final announcement as Davinci:", announcement.id);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
