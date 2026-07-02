import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const announcementsData = [
  {
    title: "Cinematic Splash Screen & Fluid Loading",
    tag: "Massive UI Overhaul",
    content: "What's New in this Update?\n\n- The Gojo Splash Screen: We've added an incredibly smooth cinematic intro that plays the first time you load the site, featuring a stunning Gojo background with dynamic CSS water droplets and progressive blurs!\n- Buttery Smooth Animations: Rebuilt the loading sequence using Pure CSS Keyframes (hardware accelerated) so there is absolutely zero lag or choppiness.\n- Zero White Flash: Eradicated the white screen flash bug entirely by rendering the site inherently in dark mode from the first millisecond.\n- Sleek Minimalist Loader: Internal page transitions now feature a sleek, glowing indigo spinner that keeps the vibe immersive.",
    image: null,
  },
  {
    title: "Netflix-Style UI & Security Upgrade",
    tag: "Major Update",
    content: "What's New in this Update?\n\n- Netflix-Style Quick View: Hovering and clicking the chevron on any anime card now pops open a sleek, glassmorphic Quick View modal right over your dashboard!\n- Background Trailers: The new Quick View modal features seamless, autoplaying background trailers just like Netflix.\n- Change Password: You can now securely change your password directly from the Profile Settings tab.\n- Mobile Responsiveness: The entire platform has been polished to perfection on all mobile devices, eliminating horizontal scroll bugs and ensuring perfectly constrained layouts.",
    image: null,
  },
  {
    title: "Cinematic Transitions & GIF Banners",
    tag: "Platform Updates",
    content: "Latest Platform Improvements\n\n- Cinematic Page Transitions: The entire website now features fluid fade and slide animations when navigating between pages.\n- Animated GIF Banners: Users who have reached 500 Arise Points (or Lead Dev status) can now upload animated GIFs for their profile background banners!\n- Community Fixes: We've completely bulletproofed the Community page against crashes from deleted accounts or missing data.",
    image: null,
  },
  {
    title: "Cinematic Trailers & Liquid Glass UI",
    tag: "Massive UI Overhaul",
    content: "What's New in this Update?\n\n- Cinematic Trailer Player: Instantly watch anime trailers without leaving the app! The new trailer modal pops up with a beautiful glassmorphic backdrop.\n- Liquid Glass Aesthetics: The entire interface has been upgraded to a premium translucent glass aesthetic with edge-to-edge backdrop blurs.\n- Dynamic Card Tracking: Hovering edge cards in the carousel now dynamically adjusts origin points to perfectly prevent clipping.\n- Interactive Hover Actions: Add to Watchlist, Like, and Play trailers directly from the Netflix-style popout cards without navigating away!",
    image: null,
  },
  {
    title: "Community Feed & Ranks",
    tag: "Major Update",
    content: "What's New in the Community?\n\n- Nested Replies: You can now reply directly to specific comments, creating Reddit-style discussion threads!\n- Rank Badges: Every comment you post now automatically displays your Arise Point rank badge and icon!\n- Upvote Rewards: You automatically earn +1 ✧ Arise Point when someone upvotes your post!\n- Score Sorting: Highly upvoted posts naturally rise to the top of the feed!\n- Anime Context: The Global Feed on the Home Page now tells everyone exactly which anime you were discussing!",
    image: null,
  },
  {
    title: "Discord Auth & Profiles",
    tag: "New Features",
    content: "Identity Upgrades\n\n- Discord Integration: You can now register and log in instantly with one click using the new 'Continue with Discord' button!\n- Avatar Cropper: Added a sleek image cropper when uploading your profile picture to ensure a perfect 1:1 square.\n- Cinematic Banners: Upload a custom background banner for your profile. The new cropper perfectly locks it into a cinematic 3:1 ratio!\n- Netflix-Style Hover Cards: Hovering over anime posters now features a smoother Apple iOS-style spring animation.",
    image: null,
  },
  {
    title: "Arise Point Economy",
    tag: "Progression",
    content: "Track Your Journey\n\n- Point History Modal: Click on your Arise Points number inside your profile to open a detailed ledger of every point you've ever earned or spent.\n- Point Deductions: If someone removes their upvote, or if you delete your comment, the associated points are accurately removed from your account.\n- Activity Rewards: Earn points for adding to watchlists, updating your avatar, following the Lead Developer, and sharing views!\n- Titles & Colors: Reaching thresholds (e.g. God-Level) permanently recolors your entire profile to flex your status!",
    image: null,
  },
  {
    title: "Message from Lead Dev",
    tag: "Announcement",
    content: "Who is dejavuh?\n\nI am the Lead Developer of the Da Vinci platform. My goal is to build the ultimate cinematic tracker experience for anime enthusiasts. Visit my profile to see my exclusive Hollow Purple animation!",
    image: null,
  }
];

async function main() {
  console.log("Seeding announcements...");

  // Find dejavuh account
  const devUser = await prisma.user.findFirst({
    where: {
      username: {
        equals: "dejavuh",
        mode: "insensitive"
      }
    }
  });

  if (!devUser) {
    console.error("dejavuh user not found! Cannot seed announcements.");
    return;
  }

  // Clear existing announcements to prevent duplicates
  await prisma.announcement.deleteMany({
    where: { authorId: devUser.id }
  });
  console.log("Cleared existing announcements.");

  // Insert backwards so they show up in chronological order in the feed
  for (let i = announcementsData.length - 1; i >= 0; i--) {
    const ann = announcementsData[i];
    await prisma.announcement.create({
      data: {
        authorId: devUser.id,
        title: ann.title,
        content: ann.content,
        tag: ann.tag,
        image: ann.image
      }
    });
    console.log(`Created: ${ann.title}`);
  }

  console.log("Seeding complete!");
}

main()
  .catch(e => {
    console.error(e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
