// Station-in-a-box format presets: everything a new station needs to sound right on day one.
// Seed artists build a starter library from monochrome without any AI; when Claude is available
// it adds depth and variety on top.

const STD_CLOCK = (name = 'Music Hour') => ({
  name,
  color: '#6366f1',
  items: [
    { type: 'toh_id' },
    { type: 'music', category: 'A' },
    { type: 'music', category: 'C' },
    { type: 'dj', mode: 'auto' },
    { type: 'music', category: 'B' },
    { type: 'sweeper' },
    { type: 'music', category: 'G' },
    { type: 'music', category: 'A' },
    { type: 'stopset', spots: 3 },
    { type: 'weather' },
    { type: 'music', category: 'N' },
    { type: 'music', category: 'B' },
    { type: 'sweeper' },
    { type: 'music', category: 'C' },
    { type: 'dj', mode: 'frontsell' },
    { type: 'music', category: 'A' },
    { type: 'music', category: 'G' },
    { type: 'stopset', spots: 3 },
    { type: 'traffic' },
    { type: 'music', category: 'B' },
    { type: 'sweeper' },
    { type: 'music', category: 'A' },
    { type: 'music', category: 'C' },
  ],
});

const DRIVE_CLOCK = {
  name: 'Drive Time',
  color: '#0ea5e9',
  items: [
    { type: 'toh_id' },
    { type: 'news' },
    { type: 'traffic' },
    { type: 'music', category: 'A' },
    { type: 'dj', mode: 'auto' },
    { type: 'music', category: 'C' },
    { type: 'music', category: 'B' },
    { type: 'stopset', spots: 4 },
    { type: 'weather' },
    { type: 'music', category: 'G' },
    { type: 'sweeper' },
    { type: 'music', category: 'A' },
    { type: 'traffic' },
    { type: 'music', category: 'B' },
    { type: 'dj', mode: 'talk' },
    { type: 'music', category: 'N' },
    { type: 'stopset', spots: 4 },
    { type: 'weather' },
    { type: 'music', category: 'A' },
    { type: 'sweeper' },
    { type: 'music', category: 'C' },
  ],
};

const NIGHT_CLOCK = {
  name: 'Overnight',
  color: '#a855f7',
  items: [
    { type: 'toh_id' },
    { type: 'music', category: 'B' },
    { type: 'music', category: 'G' },
    { type: 'sweeper' },
    { type: 'music', category: 'C' },
    { type: 'music', category: 'A' },
    { type: 'dj', mode: 'backsell' },
    { type: 'music', category: 'N' },
    { type: 'music', category: 'G' },
    { type: 'stopset', spots: 2 },
    { type: 'music', category: 'B' },
    { type: 'sweeper' },
    { type: 'music', category: 'C' },
    { type: 'music', category: 'A' },
    { type: 'music', category: 'G' },
    { type: 'sweeper' },
    { type: 'music', category: 'B' },
  ],
};

const CURRENT_CATS = [
  { id: 'A', name: 'Power Current', minRestHours: 2.5 },
  { id: 'B', name: 'Current', minRestHours: 4 },
  { id: 'C', name: 'Recurrent', minRestHours: 8 },
  { id: 'G', name: 'Gold', minRestHours: 24 },
  { id: 'N', name: 'New / Discovery', minRestHours: 6 },
];

const GOLD_CATS = [
  { id: 'A', name: 'Power Gold', minRestHours: 6 },
  { id: 'B', name: 'Secondary Gold', minRestHours: 12 },
  { id: 'C', name: 'Deep Tracks', minRestHours: 36 },
  { id: 'G', name: 'Classics', minRestHours: 18 },
  { id: 'N', name: 'Recent / Fresh', minRestHours: 10 },
];

const IMAGING = (lines) => [
  { type: 'toh_id', name: 'Legal ID', text: lines.legal || '{callSign}, {frequency}. {name}. {market}.' },
  { type: 'toh_id', name: 'Legal ID (alt)', text: lines.legal2 || 'You\'re listening to {name}. {callSign}, {market}.' },
  { type: 'id', name: 'Station ID', text: lines.id || '{name}. {slogan}.' },
  { type: 'id', name: 'Station ID (short)', text: '{frequency}. {name}.' },
  ...lines.sweepers.map((t, i) => ({ type: 'sweeper', name: `Sweeper ${i + 1}`, text: t })),
  { type: 'liner', name: 'Into Break', text: lines.liner || '{name}. Back in a minute.' },
];

export const FORMATS = {
  chr: {
    name: 'Top 40 / CHR', description: 'Today\'s biggest hits, high energy.',
    format: 'Contemporary Hit Radio (Top 40): the biggest current pop, hip-hop and dance hits, plus recent recurrents. High energy, fast-paced.',
    processing: 'chr', categories: CURRENT_CATS, mode: 'current',
    seeds: ['Dua Lipa', 'The Weeknd', 'Sabrina Carpenter', 'Taylor Swift', 'Billie Eilish', 'Olivia Rodrigo', 'Harry Styles', 'Doja Cat', 'Post Malone', 'Ariana Grande', 'Bruno Mars', 'Lady Gaga', 'Chappell Roan', 'Benson Boone', 'Teddy Swims', 'SZA', 'Ed Sheeran', 'Miley Cyrus', 'Tate McRae', 'Charli xcx', 'Rihanna', 'Justin Bieber', 'Katy Perry', 'Shawn Mendes', 'Calvin Harris', 'David Guetta', 'Imagine Dragons', 'OneRepublic', 'Coldplay', 'Maroon 5'],
    personas: [
      { name: 'Jess', style: 'Bright, witty, pop-culture obsessed host in her late 20s. Quick, playful, never cheesy. Talks like a friend texting you the tea.', kokoroVoice: 'af_heart', elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL', openaiVoice: 'coral' },
      { name: 'Marcus', style: 'Energetic, warm, funny host in his early 30s. Big laugh, loves the music, keeps it moving.', kokoroVoice: 'am_puck', elevenLabsVoiceId: 'pNInz6obpgDQGcFmaJgB', openaiVoice: 'ash' },
    ],
    imaging: { sweepers: ['All the hits. All the time. {name}.', 'Today\'s biggest hits, right now on {name}.', 'More music, more hits. {frequency}.', 'Turn it up. This is {name}.'], id: '{name}. {slogan}.' },
  },
  hotac: {
    name: 'Hot AC', description: 'Upbeat pop and pop-rock, 2000s to today.',
    format: 'Hot Adult Contemporary: upbeat pop and pop-rock hits from the 2000s to today, with some 80s and 90s gold. Familiar, feel-good, bright.',
    processing: 'chr', categories: CURRENT_CATS, mode: 'current',
    seeds: ['Dua Lipa', 'The Killers', 'Coldplay', 'Harry Styles', 'Taylor Swift', 'Maroon 5', 'P!nk', 'Kelly Clarkson', 'OneRepublic', 'Imagine Dragons', 'Bruno Mars', 'Ed Sheeran', 'Adele', 'Train', 'Matchbox Twenty', 'Lady Gaga', 'Katy Perry', 'The Weeknd', 'Lizzo', 'Sabrina Carpenter', 'Panic! At The Disco', 'Fall Out Boy', 'Avril Lavigne', 'Daft Punk', 'Calvin Harris', 'Gwen Stefani', 'Mark Ronson', 'Walk The Moon', 'Bastille', 'Hozier'],
    personas: [
      { name: 'Max', style: 'Warm, quick-witted host in his 30s. Conversational, a little self-deprecating, loves music trivia. Talks to one listener.', kokoroVoice: 'am_michael', elevenLabsVoiceId: 'pNInz6obpgDQGcFmaJgB', openaiVoice: 'ash' },
      { name: 'Nova', style: 'Smooth, confident, friendly host in her late 20s. Genuine enthusiasm, a bit playful, relaxed delivery.', kokoroVoice: 'af_heart', elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL', openaiVoice: 'coral' },
    ],
    imaging: { sweepers: ['More music. Less talk. {name}.', 'The best variety of the 2000s and today. {frequency}.', 'Feel-good radio. This is {name}.', 'Your workday soundtrack. {name}.'] },
  },
  ac: {
    name: 'Adult Contemporary', description: 'Soft, familiar favorites. Easy at-work listening.',
    format: 'Adult Contemporary: soft, familiar pop favorites from the 80s to today. Relaxing, positive, great for at-work listening.',
    processing: 'ac', categories: GOLD_CATS, mode: 'gold',
    seeds: ['Adele', 'Ed Sheeran', 'Phil Collins', 'Whitney Houston', 'Elton John', 'Celine Dion', 'Michael Bublé', 'Norah Jones', 'John Legend', 'Lionel Richie', 'Fleetwood Mac', 'Billy Joel', 'Mariah Carey', 'Shania Twain', 'Rod Stewart', 'Hall & Oates', 'Sheryl Crow', 'Train', 'Christina Perri', 'Lewis Capaldi', 'James Arthur', 'Josh Groban', 'Bryan Adams', 'Gloria Estefan', 'Michael McDonald'],
    personas: [
      { name: 'Claire', style: 'Calm, warm, reassuring host in her 40s. Kind humor, community-minded, never rushed.', kokoroVoice: 'af_heart', elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL', openaiVoice: 'shimmer' },
      { name: 'Tom', style: 'Friendly, easygoing host in his 50s. Gentle wit, great storyteller, talks like a good neighbor.', kokoroVoice: 'am_michael', elevenLabsVoiceId: 'pNInz6obpgDQGcFmaJgB', openaiVoice: 'echo' },
    ],
    imaging: { sweepers: ['Your favorite songs, all day at work. {name}.', 'Relax. You\'re listening to {name}.', 'Soft favorites. {frequency}.'] },
  },
  classichits: {
    name: 'Classic Hits', description: 'The greatest hits of the 70s, 80s and 90s.',
    format: 'Classic Hits: the biggest pop, rock and R&B hits of the 1970s, 80s and 90s. Fun, nostalgic singalongs.',
    processing: 'ac', categories: GOLD_CATS, mode: 'gold',
    seeds: ['Michael Jackson', 'Madonna', 'Prince', 'Queen', 'Journey', 'Bon Jovi', 'Whitney Houston', 'Hall & Oates', 'Duran Duran', 'Tears For Fears', 'Billy Joel', 'Elton John', 'Earth, Wind & Fire', 'The Police', 'Cyndi Lauper', 'Toto', 'Def Leppard', 'Eurythmics', 'a-ha', 'Bee Gees', 'ABBA', 'Fleetwood Mac', 'Phil Collins', 'Simple Minds', 'Wham!', 'Lionel Richie', 'Blondie', 'The Cars', 'INXS', 'Rick Astley'],
    personas: [
      { name: 'Danny', style: 'Upbeat, nostalgic host in his 50s with endless music stories from the era. Warm and fun.', kokoroVoice: 'am_michael', elevenLabsVoiceId: 'pNInz6obpgDQGcFmaJgB', openaiVoice: 'ballad' },
      { name: 'Linda', style: 'Bubbly, witty host who grew up on these songs. Loves the memories and the trivia.', kokoroVoice: 'af_bella', elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL', openaiVoice: 'coral' },
    ],
    imaging: { sweepers: ['The greatest hits of the 70s, 80s and 90s. {name}.', 'Sing along. It\'s {name}.', 'Your all-time favorites. {frequency}.'] },
  },
  classicrock: {
    name: 'Classic Rock', description: 'The legends of rock.',
    format: 'Classic Rock: the legends of rock from the late 60s through the 90s, big guitar anthems and deep cuts.',
    processing: 'rock', categories: GOLD_CATS, mode: 'gold',
    seeds: ['Led Zeppelin', 'AC/DC', 'Queen', 'The Rolling Stones', 'Aerosmith', 'Tom Petty and the Heartbreakers', 'Fleetwood Mac', 'Eagles', 'Pink Floyd', 'Van Halen', 'Boston', 'Journey', 'Bon Jovi', 'Def Leppard', 'Lynyrd Skynyrd', 'ZZ Top', 'The Who', 'Guns N\' Roses', 'Foreigner', 'Heart', 'Bruce Springsteen', 'Creedence Clearwater Revival', 'Steve Miller Band', 'Rush', 'Bad Company', 'Kansas', 'Styx', 'Cheap Trick', 'Dire Straits', 'The Doors'],
    personas: [
      { name: 'Rick', style: 'Gravel-voiced rock veteran in his 50s. Dry humor, deep rock knowledge, zero hype, total credibility.', kokoroVoice: 'am_fenrir', elevenLabsVoiceId: 'pNInz6obpgDQGcFmaJgB', openaiVoice: 'onyx' },
      { name: 'Sam', style: 'Younger rock fan who\'s all-in on the classics. Enthusiastic, curious, loves the stories behind the songs.', kokoroVoice: 'af_nicole', elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL', openaiVoice: 'sage' },
    ],
    imaging: { sweepers: ['Classic rock lives here. {name}.', 'Turn it up. {frequency}.', 'The legends of rock. {name}.'] },
  },
  alternative: {
    name: 'Alternative', description: 'Modern rock and indie, new and classic alternative.',
    format: 'Alternative: modern rock and indie, new music first, plus 90s and 2000s alternative classics.',
    processing: 'rock', categories: CURRENT_CATS, mode: 'current',
    seeds: ['Foo Fighters', 'Arctic Monkeys', 'The Killers', 'Red Hot Chili Peppers', 'Twenty One Pilots', 'Imagine Dragons', 'Muse', 'Green Day', 'The Strokes', 'Cage The Elephant', 'Glass Animals', 'Mumford & Sons', 'Florence + The Machine', 'Linkin Park', 'Nirvana', 'Pearl Jam', 'Weezer', 'Vampire Weekend', 'The Black Keys', 'Kings of Leon', 'Hozier', 'Bleachers', 'Paramore', 'Phoenix', 'Foster The People', 'Royal Blood', 'Queens of the Stone Age', 'Radiohead', 'MGMT', 'The 1975'],
    personas: [
      { name: 'Jordan', style: 'Laid-back, knowledgeable alt-music nerd. Understated, dry wit, genuinely excited about new bands.', kokoroVoice: 'am_puck', elevenLabsVoiceId: 'pNInz6obpgDQGcFmaJgB', openaiVoice: 'verse' },
      { name: 'Riley', style: 'Cool, curious host who goes to every show. Honest takes, no fake hype.', kokoroVoice: 'af_nicole', elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL', openaiVoice: 'sage' },
    ],
    imaging: { sweepers: ['New music first. {name}.', 'This is alternative. {frequency}.', 'Real rock. Real new. {name}.'] },
  },
  country: {
    name: 'Country', description: 'Today\'s country hits and recent favorites.',
    format: 'Country: today\'s biggest country hits and recent favorites, with a few 90s and 2000s country classics.',
    processing: 'country', categories: CURRENT_CATS, mode: 'current',
    seeds: ['Morgan Wallen', 'Luke Combs', 'Zach Bryan', 'Chris Stapleton', 'Carrie Underwood', 'Kacey Musgraves', 'Lainey Wilson', 'Luke Bryan', 'Jason Aldean', 'Thomas Rhett', 'Kane Brown', 'Miranda Lambert', 'Blake Shelton', 'Keith Urban', 'Dan + Shay', 'Florida Georgia Line', 'Kenny Chesney', 'Tim McGraw', 'Shania Twain', 'Garth Brooks', 'George Strait', 'Brooks & Dunn', 'Cody Johnson', 'Jelly Roll', 'Riley Green', 'Bailey Zimmerman', 'Jordan Davis', 'Old Dominion', 'Lady A', 'Eric Church'],
    personas: [
      { name: 'Cody', style: 'Easygoing, good-humored country boy in his 30s. Down to earth, loves trucks, football and his dog.', kokoroVoice: 'am_michael', elevenLabsVoiceId: 'pNInz6obpgDQGcFmaJgB', openaiVoice: 'ash' },
      { name: 'Sadie', style: 'Warm, funny, straight-talking host. Big heart, quick laugh, knows every artist\'s story.', kokoroVoice: 'af_bella', elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL', openaiVoice: 'coral' },
    ],
    imaging: { sweepers: ['Today\'s best country. {name}.', 'Country lives here. {frequency}.', 'More country, more variety. {name}.'] },
  },
  urban: {
    name: 'Hip-Hop & R&B', description: 'The hottest hip-hop and R&B.',
    format: 'Hip-Hop & R&B (Rhythmic): the hottest hip-hop and R&B, current hits first, with throwbacks from the 2000s and 2010s. Clean radio edits only.',
    processing: 'urban', categories: CURRENT_CATS, mode: 'current',
    seeds: ['Drake', 'Kendrick Lamar', 'SZA', 'Travis Scott', 'Doja Cat', 'Future', 'Metro Boomin', 'J. Cole', 'Beyoncé', 'Rihanna', 'Chris Brown', 'Usher', 'Nicki Minaj', 'Cardi B', 'Megan Thee Stallion', 'Lil Baby', 'Post Malone', 'Summer Walker', 'Jhené Aiko', 'Bryson Tiller', 'GloRilla', 'Latto', '21 Savage', 'Lil Wayne', 'Kanye West', 'Alicia Keys', 'Brent Faiyaz', 'Tems', 'Burna Boy', 'Childish Gambino'],
    personas: [
      { name: 'Dre', style: 'Confident, charismatic, funny host. Knows the culture, keeps it real, high energy without yelling.', kokoroVoice: 'am_puck', elevenLabsVoiceId: 'pNInz6obpgDQGcFmaJgB', openaiVoice: 'ash' },
      { name: 'Kayla', style: 'Smooth, sassy, smart host. Pop-culture queen, quick comebacks, warm with listeners.', kokoroVoice: 'af_bella', elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL', openaiVoice: 'coral' },
    ],
    imaging: { sweepers: ['The hottest hip-hop and R&B. {name}.', 'Hip-hop and R&B, all day. {frequency}.', 'Run it back. {name}.'] },
  },
  dance: {
    name: 'Dance / EDM', description: 'Dance hits, house and EDM.',
    format: 'Dance / EDM: dance-pop hits, house and EDM anthems, current and classic club favorites. Keep the energy and tempo up.',
    processing: 'dance', categories: CURRENT_CATS, mode: 'current',
    seeds: ['Calvin Harris', 'David Guetta', 'Avicii', 'Swedish House Mafia', 'Fred again..', 'Disclosure', 'Kygo', 'Martin Garrix', 'Zedd', 'Tiësto', 'Daft Punk', 'Fisher', 'John Summit', 'Dom Dolla', 'Peggy Gou', 'Purple Disco Machine', 'Robin Schulz', 'Alesso', 'Diplo', 'Marshmello', 'The Chainsmokers', 'Clean Bandit', 'Duke Dumont', 'Rudimental', 'Galantis', 'Armin van Buuren', 'Eric Prydz', 'Kaskade', 'Sigala', 'MK'],
    personas: [
      { name: 'Ava', style: 'High-energy, upbeat club host. Fun, warm, all about the vibe. Short, punchy breaks.', kokoroVoice: 'af_bella', elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL', openaiVoice: 'coral' },
      { name: 'Leo', style: 'Cool, smooth host with dance-music cred. Effortless, confident, keeps the party rolling.', kokoroVoice: 'am_puck', elevenLabsVoiceId: 'pNInz6obpgDQGcFmaJgB', openaiVoice: 'verse' },
    ],
    imaging: { sweepers: ['Non-stop dance hits. {name}.', 'Feel the beat. {frequency}.', 'The party starts here. {name}.'] },
  },
};

export function formatList() {
  return Object.entries(FORMATS).map(([id, f]) => ({ id, name: f.name, description: f.description, processing: f.processing, seedCount: f.seeds.length }));
}

export function formatImaging(id) {
  const f = FORMATS[id];
  return IMAGING(f.imaging);
}

export function formatClocks() {
  return [STD_CLOCK('Music Hour'), DRIVE_CLOCK, NIGHT_CLOCK];
}
