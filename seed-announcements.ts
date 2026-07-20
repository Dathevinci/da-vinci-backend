import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// The Dev Blog entries that should exist on the Updates page (newest first).
const announcementsData = [
  {
    title: "Da Vinci — Dev Blog 1.5.1: Light Novels, Real Support & a Safer Account",
    tag: "Dev Blog",
    content:
      "Da Vinci — Dev Blog 1.5.1\n\n" +
      "1.5 reimagined your profile. 1.5.1 grows the library, opens up real ways to support the atelier, and quietly makes your account a lot safer. Here's everything.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "NEW — Light Novels\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Da Vinci is no longer just anime and manhwa — there's a whole third mode for Light Novels, wrapped in its own pink theme. Browse a Netflix-style home feed with a hero banner, Trending and Recently Updated shelves and HD covers, then drop into a clean reader with adjustable font size that remembers exactly where you left off. We now pull from two sources, so the catalogue is huge — including the ones you kept asking for, like Omniscient Reader's Viewpoint. Switch modes any time from the nav bar.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "NEW — Novels on your profile\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Your profile Collection now has a third tab: Novels. Track what you're Reading, Finished, or planning to start — exactly like your anime and manhwa, with the status picker right on the card. Your whole library, finally in one place.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "NEW — Support the atelier\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "We keep Da Vinci ad-free — and now it's easy to help keep it that way. The Support page has been completely redesigned with a live funding tracker and a Hall of Patrons. Become a Supporter through Ko-fi and you'll earn a gold Supporter badge on your profile plus Arise Points, applied automatically. Prefer to just top up? You can buy Arise Points directly. Pop your username in the Ko-fi note and the perks land within a minute.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "The shop, upgraded\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Every frame and effect is still yours for Arise Points — and if you're short, you can now top up with real money right from the shop. Same cosmetics, more ways to get them.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "Behind the scenes\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Your account is meaningfully safer: sign-ins now issue a secure session token, and only you can change or delete your own account. We also smoothed out scrolling and loading across the app. Nothing you need to do — it just works.\n\n" +

      "Thank you for being here. More soon. 💜",
    image: null,
  },
  {
    title: "Da Vinci — Dev Blog 1.5: The Profile, Reimagined — Popouts, a New Card & Divine Blessings",
    tag: "Dev Blog",
    content:
      "Da Vinci — Dev Blog 1.5: The Profile, Reimagined\n\n" +
      "1.4.2 was about what you wear. 1.5 is about where you wear it. The whole profile has been rebuilt into a Discord-style card, your effects finally sit still when you scroll, you can peek at anyone's profile without ever leaving the page, and the community got a little divine intervention. Here's everything.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "NEW — The two-column profile\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Your profile is now a proper Discord-style card: a banner up top, your avatar overlapping it, your name, every stacked title, your level, bio and stats — all in one tall card on the LEFT, with your entire anime Collection filling the RIGHT. And your equipped effect now plays across the WHOLE card as a single, cohesive piece instead of a thin strip behind your name. It finally reads as one thing.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "Effects that actually stick\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Every profile effect used to lag behind and trail your avatar the second you scrolled — the effect was pinned to your screen, not your card. No more. All thirteen effects are now locked to your profile card and scroll with it as one unit, exactly like a Discord effect: zero lag, zero trailing. We also softened The Ancient Jungle's light beams and resized it on phones so it frames your avatar instead of swallowing it.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "NEW — Profile popouts, everywhere\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Click anyone's avatar or name — in the Community, the feed, the comments, or the nav bar — and their profile card pops out right there, effect and all, without ever navigating away. Check someone out and get straight back to what you were doing.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "NEW — Divine Blessing\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Staff can now bless a truly great comment. A Divine Blessing grants its author a one-time gift of 500 Arise Points, and the blessed comment is marked forever with a golden badge and a soft amber glow so everyone knows it was touched. One blessing per comment. Post something worth blessing.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "Shop polish\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "- Long cosmetic descriptions now collapse to a few lines with a 'See more', so the shop scans clean again.\n" +
      "- The 'Explore' and 'Take me there' buttons up top now actually jump you down to the right section, instead of quietly changing a filter you couldn't see.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "From the Creator\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "The cosmetics were half the story; this is the stage they stand on. The profile is the heart of Da Vinci, and it finally feels like it. Next up: bundles — themed sets of a decoration, a banner and an effect, sold together at a discount. Tell me what you think of the new look in the comments.\n\n" +
      "More soon.\n\n" +
      "— dejavuh, Lead Developer & Creator",
    image: null,
  },
  {
    title: "Da Vinci — Dev Blog 1.4.2: The SSS Era, Stacking Titles & the Path of the Heart",
    tag: "Dev Blog",
    content:
      "Da Vinci — Dev Blog 1.4.2: The SSS Era, Stacking Titles & the Path of the Heart\n\n" +
      "1.4.1 gave the dedicated their titles and the Extreme Rares. 1.4.2 goes further: the very first SSS-grade cosmetics, a whole new progression track that has nothing to do with grinding, and a long-overdue fix so the titles you earn finally sit side by side instead of fighting each other. Here's everything that landed.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "NEW — SSS GRADE: The Silent Himalayas\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "The loudest cosmetics get all the attention — so this one is the opposite. Equip The Silent Himalayas and, the moment someone opens your profile, night falls on the roof of the world. Three ranges of moonlit Himalayan peaks rise across their ENTIRE screen — deep twilight blue in the distance, icy silver up front — while heavy, weightless snow drifts down in three layers of real depth, fluttering without a breath of wind. Freezing mist rolls along the ridges, and the snow quietly PILES: soft rolling drifts gather at the bottom of the screen and a gentle cap settles on the crown of your avatar. Sagarmāthā's silence, rendered live. The crown jewel of calm — 25,500 AP.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "NEW — Extreme Rare: The Ghost Samurai\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "The blade remembers. A spectral katana — hamon glinting along its tempered edge — floats across your avatar, and every six seconds it draws in a flash: a lightning-fast iaijutsu slash that carves a glowing crimson crescent around you and sends a gust ripping through the storm of sakura petals falling across the whole screen. Your avatar rests in an aura of crimson and pale steel. The Ghost does not miss. 12,000 AP.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "The ritual speaks now\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "「 With this treasure, I summon— 」 The SSS summoning ritual now plays its chant ALOUD when your profile opens — and it's timed to the animation. The Eight-Handled Wheel holds impossibly still while the chant rings out, then the first 45-degree snap — sparks, screen-shake and all — lands exactly on the final beat. We also pulled the shadows back so the ritual stops burying the profile: the drama stays, your name and stats stay readable.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "NEW — Heart Cultivation: the path of the open heart\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "A second title track, earned purely by climbing — one Opening per level, from the first crack of empathy to something vast enough to hold every heart within it. Hover any Heart badge to read its full lore: the heart stage and the ability it grants.\n\n" +
      "   Rank I    🌱  The Tender            初開\n" +
      "   Rank II   🕯️  The Witness           見苦\n" +
      "   Rank III  🤝  The Devoted           誓心\n" +
      "   Rank IV   ⚖️  The Burdened          承重\n" +
      "   Rank V    🔥  The Burning           心火\n" +
      "   Rank VI   🌊  The Vast              廣心\n" +
      "   Rank VII  🪞  The Mirror            映心\n" +
      "   Rank VIII 🌸  The Undying Compassion 不滅悲\n" +
      "   Rank IX   💠  The Living Sanctuary   活聖域\n" +
      "   Rank X    ❤️  The All-Bearing        萬心歸\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "Titles now STACK — wear them all\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "The old system made your badges fight: a shop title would hide your level title, which hid your staff badge. No more. Your staff badge, your level title, your Heart Cultivation rank, and any title you bought now all sit SIDE BY SIDE on your profile. Everything you've earned shows at once.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "For our donors\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Our exclusive donor realm was locking its owner IN — you couldn't wear anything else. Fixed: you can now equip any shop effect you own, your exclusive realm waits for you the instant you unequip (you never lose it), and only you can summon or silence it, from a card in the shop that only you can see.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "Polish\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "- The Himalayan peaks were reworked to sit in the background so they never bury your profile or your collection.\n" +
      "- Snow now reads as snow — a soft drift and clear falling flakes, not a wall of white.\n" +
      "- The avatar snow cap rests on the crown of your picture instead of covering your face.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "Your turn — and a real question about the Shop\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "This is the part I actually need you for. The shop is growing fast — frames, effects, Extreme Rares, and now SSS-grade takeovers — and I want to know how it's landing with YOU:\n\n" +
      "- Does the shop feel good to browse, or is it getting cluttered as it grows?\n" +
      "- Are the prices fair for what each tier gives you?\n" +
      "- What would you spend Arise Points on next — more effects? Profile banners? Animated titles? Seasonal drops?\n" +
      "- Which of the new cosmetics is your favourite, and what's one you wish existed?\n\n" +
      "Drop your thoughts in the comments below or over in the Community. I read every one, and it genuinely decides what I build next.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "From the Creator\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "The Extreme Rares were the flex; the SSS tier is the statement, and Heart Cultivation is the reminder that not everything worth showing off has to be bought. Climb, collect, and tell me where the shop should go from here.\n\n" +
      "More soon.\n\n" +
      "— dejavuh, Lead Developer & Creator",
    image: null,
  },
  {
    title: "Da Vinci — Dev Blog 1.4.1: Titles of Ascension & the Rarest Drip",
    tag: "Dev Blog",
    content:
      "Da Vinci — Dev Blog 1.4.1: Titles of Ascension & the Rarest Drip\n\n" +
      "A point release, but a chunky one. Your level finally means something at a glance, the shop got a proper brain, and a handful of jaw-dropping, screen-devouring cosmetics just dropped for the truly dedicated. Here's what landed since 1.4.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "NEW: Level Titles — wear your grind\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Every level now carries its own title AND its own colour theme — your name gradient, badge, and profile glow escalate as you climb. Reach the level, wear the title. No purchase, no grind loophole — just your XP:\n\n" +
      "   Lv 1  —  Watcher\n" +
      "   Lv 2  —  Overseer\n" +
      "   Lv 3  —  Sleepless\n" +
      "   Lv 4  —  Peak Seeker\n" +
      "   Lv 5  —  Maniac\n" +
      "   Lv 6  —  Conqueror\n" +
      "   Lv 7  —  Eye of Calamity\n" +
      "   Lv 8  —  High Dimensional Overseer\n" +
      "   Lv 9  —  Will of Eternity\n" +
      "   Lv 10 —  Delusion Entity\n\n" +
      "It shows on your profile, next to your comments, and on Dev Blog posts. Bought a title from the shop? That always takes priority — it even overrides the Lead Dev and Admin badges.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "The Rarest Drip — Extreme Rare profile effects\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "These aren't little avatar sparkles. Equip one and, the moment anyone opens your profile, a full-screen cinematic takeover engulfs their ENTIRE window — real HTML5-canvas weather, physics and all. Reserved for the few with the Arise Points to spare:\n\n" +
      "- Voltaic Ascension — amethyst lightning crackles around you, violet smoke pours across your card, and reality tears open in a warp of light.\n" +
      "- Monarch's Tempest — a dark-fantasy storm: pouring parallax rain, branched lightning strikes, and thunder-flash lighting across the whole page.\n" +
      "- Event Horizon — your avatar becomes a black hole; a spiral galaxy wheels around it and a doomed star spaghettifies as it's devoured.\n" +
      "- Fog of History — the endless Grey Fog rolls over the screen, crimson stars pulse within it, and silver spirit threads snake out of the mist to bind to your avatar.\n" +
      "- Evernight's Blessing — a colossal Crimson Moon rises, the River of Eternal Darkness churns below, and night-vanilla blossoms drift into orbit around you.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "Froggie Frenzy — the cutest thing money can buy\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Not everything has to be doom and cosmic dread. For a mere 500 AP, a hand-drawn chibi froggie hops around your avatar, lily pads and lotus bloom across your card, and it sprints past going 'ribbit ribbit'. 100% serious. 100% ribbit.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "A smarter Shop\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "As the collection grows, finding things shouldn't get harder. The shop now has live search, category tabs (with counts), an Everything / For Sale / Owned filter, and an 'Equipped now' bar so you can see — and one-tap unequip — exactly what you're wearing.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "Fixes & polish\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "- A frame you bought now always wins over your rank glow, so your chosen ring shows clean.\n" +
      "- The black hole no longer gets clipped inside the card — the galaxy spirals freely across the page.\n" +
      "- Heavy effects are gated so busy pages (community, directory) stay smooth.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "From the Creator\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Titles are the reward for showing up; the Extreme Rares are for the ones who go all in. Climb, flex, and — if you're feeling it — go make someone's whole screen storm.\n\n" +
      "More soon.\n\n" +
      "— dejavuh, Lead Developer & Creator",
    image: null,
  },
  {
    title: "Da Vinci — Dev Blog 1.4: Avatar Decorations & the New Arise Shop",
    tag: "Dev Blog",
    content:
      "Da Vinci — Dev Blog 1.4: Avatar Decorations & the New Arise Shop\n\n" +
      "This one's all about making your presence yours. Your Arise Points finally have something worth spending them on: a completely reimagined shop, animated avatar decorations, and Discord-style profile effects that follow you everywhere on the platform. Here's the full rundown.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "The Arise Shop, reimagined\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "The shop has been rebuilt from the ground up into a proper cosmetics store, and it's open to everyone. It's now split into two clear sections — Avatar Frames and Avatar Effects — and every item shows a live preview on YOUR avatar, so you see exactly what you're buying before you spend a single point. Every description now tells you plainly what the item does and where it shows up.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "Avatar Frames — a ring that's unmistakably yours\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Frames are animated rings that slowly rotate around your avatar. Five to collect at launch:\n\n" +
      "- Amethyst Halo — the signature violet-and-magenta Da Vinci ring.\n" +
      "- Golden Aureole — molten, spinning gold. Pure prestige.\n" +
      "- Ember Crown — a slow burn of gold, orange and crimson.\n" +
      "- Frost Sigil — icy cyan and sapphire light.\n" +
      "- Verdant Ring — emerald and jade in perpetual bloom.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "Avatar Effects — particles that bring your avatar to life\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Effects wreathe your avatar in living particles:\n\n" +
      "- Ethereal Aura — a pulsing violet halo of cosmic energy.\n" +
      "- Astral Dust — golden sparkles that drift and twinkle.\n" +
      "- Winter's Veil — a gentle, endless snowfall.\n" +
      "- Cinder Storm — glowing embers rising like a living fire.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "NEW: Profile Effects (Discord-style)\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "This is the big one. An equipped effect no longer just decorates your avatar — it now plays across your ENTIRE profile card the moment someone opens it. Snow drifts down the whole card, embers rise past your stats, sparkles shimmer, aura ripples outward — each with a one-shot intro sweep, then a calm ambient loop. Open a profile and it feels alive.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "Your decorations show up EVERYWHERE\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "What's the point of a cosmetic nobody sees? Your frame and effect now render across the whole platform — on your profile, next to every comment and community post you make, in the User Directory, in followers/following lists, up in the nav bar, and on Dev Blog posts and their comments. Equip once; it follows you.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "More ways to spend Arise Points\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "- Buy invite keys — everyone still gets one free invite, but engaged members can now buy extra invite keys with Arise Points in Settings → Invite Keys. (Staff generate them freely.)\n" +
      "- Tip a comment — spotted a great take? Tip the author some Arise Points straight from the comment. It rewards good posts and keeps AP flowing through the community.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "From the Creator\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "You asked what Arise Points were for — this is my answer, and it's only the start. I want your profile to feel like YOURS, the way a Discord profile does. Frames and effects are the foundation; more decorations, seasonal drops, and perks are on the way.\n\n" +
      "Go equip something. Then tell me what you'd add next.\n\n" +
      "— dejavuh, Lead Developer & Creator",
    image: null,
  },
  {
    title: "Da Vinci — Dev Blog 1.3: What's New",
    tag: "Dev Blog",
    content:
      "Da Vinci — Dev Blog 1.3: What's New\n\n" +
      "A big batch of polish and new toys just landed. Here's everything that's changed since the last blog.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "Your Tracker, leveled up\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "- One tracker control everywhere — on cards, the Quick View popup, and anime pages you can set a title as Watching, Watched, Waiting, or Interested (or remove it) from a single clean menu.\n" +
      "- Organized by status — your profile Collection is now grouped into Watching / Watched / Waiting / Interested sections, so your list tells a story at a glance.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "Make it yours: change your username\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "You can now change your username in Settings → Account. Your first change is free; after that it costs Arise Points, so choose wisely. And your rank/role now travels with your account — renaming yourself never strips what you've earned.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "Smoother, faster, cleaner\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "- A calmer hero — the home spotlight is now crisp cinematic key art (no more stutter or stray video buttons).\n" +
      "- Instant follows — the Follow button responds the moment you tap it.\n" +
      "- A proper branded loading screen, plus redesigned notifications that feel clean and fluid.\n" +
      "- Cleaner browsing — adult / Hentai titles are now filtered out of discovery, search, and the schedule.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "From the Creator\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Most of this came straight from your feedback — thank you. Keep it coming; it genuinely shapes what I build next.\n\n" +
      "More soon. Welcome to the new Da Vinci.\n\n" +
      "— dejavuh, Lead Developer & Creator",
    image: null,
  },
  {
    title: "Da Vinci — Dev Blog 1.2: How Leveling Works",
    tag: "Dev Blog",
    content:
      "Da Vinci — Dev Blog 1.2: How Leveling Works\n\n" +
      "This one's a deep dive. A lot of you have been grinding — watching, finishing, commenting — and asking how the numbers actually work. Here's the full breakdown of the leveling system, including a big fairness update that just went live for anyone who watches long-running series.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "Two systems: XP and Arise Points\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "There are two separate things on your profile, and they're easy to mix up:\n\n" +
      "- XP — drives your LEVEL (1 to 10). This is your progression.\n" +
      "- Arise Points (AP) — a separate currency you stack up alongside XP. AP will power future rewards, unlocks, and the shop.\n\n" +
      "Almost everything you do earns both at once, and earning AP even gives a tiny passive XP nudge — so the two grow together.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "The 10 levels (and why the top is a grind)\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Max level is 10, and the curve is exponential — each level costs roughly double the last. Total XP needed to REACH each level:\n\n" +
      "   Lv 1  —  0\n" +
      "   Lv 2  —  1,000\n" +
      "   Lv 3  —  3,000\n" +
      "   Lv 4  —  7,000\n" +
      "   Lv 5  —  15,000\n" +
      "   Lv 6  —  31,000\n" +
      "   Lv 7  —  63,000\n" +
      "   Lv 8  —  127,000\n" +
      "   Lv 9  —  255,000\n" +
      "   Lv 10 —  511,000  (max)\n\n" +
      "Early levels come fast; Level 10 is a true endgame badge. (The Lead Dev sits at infinity, and the admin team is pinned at Level 10.)\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "How to earn XP\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "- Watch an episode — +25 XP per EPISODE, counted once each. Rewatching the same episode won't farm XP, so your level reflects what you've actually seen.\n" +
      "- Finish an anime — a completion bonus that SCALES WITH LENGTH (see below).\n" +
      "- Comment or post in the community — +2 XP (and +5 AP).\n" +
      "- Follow someone — +5 AP (once per person).\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "NEW: finishing long series finally pays off\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Before, finishing a 12-episode short and finishing One Piece gave the exact same reward. That wasn't fair to anyone putting in 1,000+ episodes — so we fixed it. The completion bonus now scales with the anime's episode count:\n\n" +
      "   12 episodes         ->  +240 XP\n" +
      "   24 episodes         ->  +480 XP\n" +
      "   ~220 (Naruto)       ->  +4,400 XP   (about Level 3 on its own)\n" +
      "   1,000+ (One Piece)  ->  +12,000 XP  (roughly Level 4–5 from scratch)\n\n" +
      "It's awarded once per anime, and it stacks on top of the per-episode XP you earned along the way. Long-haul watchers — this one's for you.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "Tips to climb\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "- Actually finish your shows — the completion bonus is the single biggest XP source.\n" +
      "- Keep a real tracker — mark things Finished when you're done to bank the bonus.\n" +
      "- Be part of the community — comments and posts add up over time.\n" +
      "- Your rank badge and profile glow level up as you do.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "From the Creator\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "I want leveling to reward genuine time and love for anime — not grinding loopholes. That's why watch XP is deduped and finishing is what really moves the needle. More XP sources, things to spend Arise Points on, and level perks are all coming.\n\n" +
      "Keep watching. Keep climbing. And as always — tell me what you'd change.\n\n" +
      "— dejavuh, Lead Developer & Creator",
    image: null,
  },
  {
    title: "Da Vinci — Dev Blog 1.1",
    tag: "Dev Blog",
    content:
      "Welcome to Da Vinci — Dev Blog 1.1\n\n" +
      "You're early. Da Vinci is in an invite-only beta, so access is locked behind invite codes for now — which means if you're reading this, you're one of the founding few helping shape the platform before it opens up. Expect new features to land often, the experience to keep getting smoother, and a few rough edges here and there while we chase perfection. Thank you for being part of it.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "What's live right now\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "- Cinematic discovery — Browse trending, currently airing, seasonal, and upcoming anime through a premium, Netflix-style interface built for pure vibes.\n" +
      "- Your personal Tracker — Add anything to your list and pick up right where you left off, all in one clean place.\n" +
      "- Quick View popup — Click any title for an autoplaying background trailer, synopsis, cast, genres, episodes, and a 'More Like This' row — without ever leaving the page.\n" +
      "- Arise Points + Leveling — A brand-new XP economy (max Level 10) rewards you for watching, commenting, and following. Arise Points are a separate currency that will power future rewards.\n" +
      "- A living community — Post your views, reply in threaded discussions, upvote what you love, and earn rank badges as you climb.\n" +
      "- Polished everywhere — HD trailers, crisp cover art, fluid animations, and a fast, clean layout across desktop and mobile.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "Meet the Team\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "The people keeping Da Vinci running and the community a good place to be:\n\n" +
      "- @davinci — Administrator. The lead admin, steering moderation, community health, and the day-to-day of the platform. If something needs handling, davinci is already on it.\n" +
      "- @xhackerdevil — Administrator. Guardian of platform integrity — keeping things secure, stable, and running smoothly behind the scenes.\n" +
      "- @coffee — Administrator. The friendly face of the community — moderation and support that keeps discussions welcoming and on track.\n" +
      "- @speyvenerable — Administrator. Helping steward the community and apply the rules fairly and evenly for everyone.\n\n" +
      "Every admin can moderate posts and comments platform-wide. See their names glow? You're talking to the team.\n\n" +

      "━━━━━━━━━━━━━━━━━━\n" +
      "From the Creator\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Hey — I'm @dejavuh, the Lead Developer and creator of Da Vinci.\n\n" +
      "I built this whole thing from the ground up: the architecture, the database, the cinematic interface, and the Arise Points economy. Da Vinci started as a simple idea — that tracking and discovering anime should feel as good as watching it. Every animation, every pixel, and every late night went into chasing that feeling.\n\n" +
      "This is only the beginning. We'll keep polishing, keep shipping, and open the doors wider over time. You're here for the earliest chapter, and your feedback genuinely steers what comes next — so tell us what you love and what you'd change.\n\n" +
      "More dev blogs will always land right here. Welcome to Da Vinci.\n\n" +
      "— dejavuh, Lead Developer & Creator",
    image: null,
  },
];

async function main() {
  console.log("Seeding announcements...");

  // Author is the Lead Dev, dejavuh.
  const devUser = await prisma.user.findFirst({
    where: { username: { equals: "dejavuh", mode: "insensitive" } },
  });

  if (!devUser) {
    console.error("dejavuh user not found! Cannot seed announcements.");
    return;
  }

  // ── Backfill staff roles onto the accounts ──
  // Roles live on the account (schema `role`) so they survive username changes.
  // Tag the known staff by their case-insensitive names, so even a renamed
  // account (e.g. "Dejavuh") keeps Lead Dev / Admin going forward.
  await prisma.user.updateMany({
    where: { username: { equals: "dejavuh", mode: "insensitive" } },
    data: { role: "LEAD_DEV" },
  });
  for (const admin of ["davinci", "xhackerdevil", "coffee", "speyvenerable"]) {
    await prisma.user.updateMany({
      where: { username: { equals: admin, mode: "insensitive" } },
      data: { role: "ADMIN" },
    });
  }
  console.log("Backfilled staff roles (Lead Dev / Admins).");

  // ── Crimson donor: make the exclusive realm RENAME-PROOF ──
  // Her exclusivity used to be keyed to a hardcoded username, so renaming stripped
  // the realm. The durable marker is now that her account OWNS the un-buyable
  // effect_crimson (it lives in `purchasedEffects`) — crimson is absent from the
  // shop catalog, so it can never be bought or gifted onto anyone else. Grant that
  // marker to whoever currently WEARS crimson (only she can), so a future rename
  // can never remove it. Idempotent — skips accounts that already carry it.
  // Her CURRENT username. The activeEffect match below only reaches her if her
  // realm was explicitly summoned; when it's her silent default (empty
  // activeEffect) this username stamp is what actually marks her account. Once
  // stamped, the marker lives in purchasedEffects forever — she can rename again
  // and away from this name and never lose the realm. (Root seed scripts run
  // under ts-node without @types/node, so this is a literal, not process.env.)
  const CRIMSON_DONOR_USERNAME = "Underworld_Daoist";
  const crimsonWhere: any[] = [{ activeEffect: "effect_crimson" }];
  if (CRIMSON_DONOR_USERNAME) {
    crimsonWhere.push({ username: { equals: CRIMSON_DONOR_USERNAME, mode: "insensitive" } });
  }
  const crimsonBearers = await prisma.user.findMany({
    where: { AND: [{ OR: crimsonWhere }, { NOT: { purchasedEffects: { has: "effect_crimson" } } }] },
    select: { id: true, username: true },
  });
  for (const u of crimsonBearers) {
    await prisma.user.update({
      where: { id: u.id },
      data: { purchasedEffects: { push: "effect_crimson" } },
    });
    console.log(`Crimson donor marker granted to ${u.username} (rename-proof).`);
  }
  console.log(`Crimson donor backfill: ${crimsonBearers.length} account(s) marked.`);

  // ── Supporter badge: mark donors as Supporters (rename-proof) ──
  // The persistent "supporter" marker is tag_supporter in purchasedTags; the
  // profile renders a Supporter badge off it. Grant it to anyone who owns an
  // exclusive donor effect (effect_crimson) — i.e. our donors — so a rename can
  // never strip it. Runs AFTER the crimson backfill above, so a freshly-stamped
  // donor is caught in the same deploy. Idempotent — skips accounts that have it.
  const supporterBearers = await prisma.user.findMany({
    where: {
      AND: [
        { purchasedEffects: { has: "effect_crimson" } },
        { NOT: { purchasedTags: { has: "tag_supporter" } } },
      ],
    },
    select: { id: true, username: true },
  });
  for (const u of supporterBearers) {
    await prisma.user.update({
      where: { id: u.id },
      data: { purchasedTags: { push: "tag_supporter" } },
    });
    console.log(`Supporter badge granted to ${u.username}.`);
  }
  console.log(`Supporter backfill: ${supporterBearers.length} account(s) marked.`);

  // Remove ALL existing updates so the Updates page starts clean.
  const deleted = await prisma.announcement.deleteMany({});
  console.log(`Cleared ${deleted.count} existing announcement(s).`);

  // Insert backwards so they show up in chronological order in the feed.
  for (let i = announcementsData.length - 1; i >= 0; i--) {
    const ann = announcementsData[i];
    await prisma.announcement.create({
      data: {
        authorId: devUser.id,
        title: ann.title,
        content: ann.content,
        tag: ann.tag,
        image: ann.image,
      },
    });
    console.log(`Created: ${ann.title}`);
  }

  // ── @everyone broadcast ──
  // Ping every user about the latest Dev Blog, once. Deduped by the exact
  // message so re-running the seed on each deploy never spams anyone; brand-new
  // users who join later still receive it.
  const BROADCAST_MSG =
    "📢 @everyone — Dev Blog 1.5.1 is live: Light Novels are here (a whole new mode!), you can track novels on your profile, support the atelier for a gold Supporter badge + Arise Points, and your account is safer than ever. Read it in Updates.";

  const allUsers = await prisma.user.findMany({ select: { id: true } });
  let notified = 0;
  for (const u of allUsers) {
    if (u.id === devUser.id) continue; // don't notify the author
    const already = await prisma.notification.findFirst({
      where: { userId: u.id, message: BROADCAST_MSG },
    });
    if (already) continue;

    await prisma.notification.create({
      data: {
        userId: u.id,
        actorId: devUser.id,
        type: "announcement",
        message: BROADCAST_MSG,
        link: "/updates",
      },
    });
    notified++;
  }
  console.log(`Broadcast Dev Blog 1.5.1 to ${notified} user(s).`);

  console.log("Seeding complete!");
}

main()
  .catch((e) => {
    console.error(e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
