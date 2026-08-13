const axios = require('axios');
const Parser = require('rss-parser');
const parser = new Parser();

async function check4K(title) {
  const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(title + ' 2160p')}&c=1_2&f=0`;
  const feed = await parser.parseURL(url);
  return feed.items.length > 0;
}

async function run() {
  const titles = [
    { id: 52034, name: 'Oshi no Ko' },
    { id: 38000, name: 'Demon Slayer' },
    { id: 40748, name: 'Jujutsu Kaisen' },
    { id: 44511, name: 'Chainsaw Man' },
    { id: 41467, name: 'Bleach Thousand-Year Blood War' },
    { id: 33352, name: 'Violet Evergarden' },
    { id: 31240, name: 'Re:Zero' },
    { id: 5114, name: 'Fullmetal Alchemist Brotherhood' },
    { id: 37521, name: 'Vinland Saga' },
    { id: 21, name: 'One Piece' },
    { id: 11061, name: 'Hunter x Hunter' },
    { id: 38524, name: 'Shingeki no Kyojin Season 3' },
    { id: 40028, name: 'Shingeki no Kyojin The Final Season' },
    { id: 48583, name: 'Shingeki no Kyojin The Final Season Part 2' },
    { id: 31964, name: 'Boku no Hero Academia' },
    { id: 32281, name: 'Kimi no Na wa' }
  ];
  const validIds = [];
  for (const t of titles) {
    try {
      const has4k = await check4K(t.name);
      console.log(t.name, '=>', has4k);
      if (has4k) validIds.push(t.id);
    } catch (e) {
      console.error('Error for', t.name, e.message);
    }
  }
  console.log('Valid IDs:', validIds);
}
run();
