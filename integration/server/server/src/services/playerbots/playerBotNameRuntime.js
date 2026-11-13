"use strict";

// Names for new playerbots. Each bot takes a race (and so a bloodline and a
// starting school), and its name comes from that race's pools. The first
// name least used by the existing roster is preferred, so a seeding batch
// does not produce dozens of pilots with the same first name.

const RACE = Object.freeze({ CALDARI: 1, MINMATAR: 2, AMARR: 4, GALLENTE: 8 });

const NAME_POOLS = Object.freeze({
  [RACE.CALDARI]: Object.freeze({
    first: [
      "Aritsu", "Daemi", "Haato", "Ishiri", "Jorren", "Kaijun", "Katsen", "Kiyora", "Mikashi", "Noura",
      "Otsen", "Raika", "Sakiru", "Soryn", "Tahvo", "Tenshi", "Ulla", "Veiko", "Akemi", "Aino",
      "Eero", "Hanaki", "Ilmari", "Jusa", "Kaito", "Kenzo", "Kirsi", "Laito", "Maiju", "Masaru",
      "Niko", "Okko", "Pekko", "Reiko", "Riku", "Saara", "Seppo", "Shiro", "Suvi", "Taavi",
      "Taro", "Toivo", "Usagi", "Vaara", "Yuki", "Yrjo", "Aiko", "Haru", "Kalle", "Mirei",
    ],
    last: [
      "Ahonen", "Endashi", "Haatakan", "Isokawa", "Kaalakiota", "Kasada", "Korhonen", "Laakso", "Matsuda", "Nikkanen",
      "Okkelen", "Pashanen", "Raitaru", "Saikkonen", "Tanaka", "Tsukuni", "Uotila", "Vaskinen", "Yamura", "Aatola",
      "Hakkila", "Heikura", "Itsuki", "Junttila", "Kaiho", "Kitano", "Lehtola", "Makita", "Murakai", "Nurmela",
      "Oshiro", "Paavola", "Rintala", "Sakamura", "Seppala", "Takeshi", "Toivola", "Ukkonen", "Valtari", "Yokota",
      "Arvola", "Hirano", "Kanerva", "Kuroda", "Lindqvara", "Mikkola", "Nakaro", "Ollila", "Ruotsi", "Tervo",
    ],
  }),
  [RACE.MINMATAR]: Object.freeze({
    first: [
      "Arnar", "Brakka", "Dagny", "Eirik", "Frida", "Gunnar", "Halla", "Ingvar", "Jorund", "Katla",
      "Leif", "Magna", "Njal", "Orla", "Ragnar", "Sigrun", "Thora", "Ulfar", "Valka", "Yrsa",
      "Asger", "Bodvar", "Dalla", "Eldar", "Freyr", "Gerd", "Hakon", "Idun", "Kolbein", "Liv",
      "Mord", "Nanna", "Odd", "Runa", "Skuli", "Tove", "Vigdis", "Bjarki", "Edda", "Hrefna",
      "Kari", "Svala", "Thrain", "Ylva", "Arngrim", "Brynja", "Grima", "Haldor", "Saga", "Torvald",
    ],
    last: [
      "Arnason", "Brutor", "Dagsdottir", "Eldjarn", "Fenrar", "Gilsson", "Hrafnar", "Isarsson", "Jorsvik", "Krusual",
      "Ljotsson", "Matarnir", "Nefsson", "Orvald", "Ragnarsson", "Sebiestor", "Tronhadar", "Ulfsdottir", "Vherokior", "Ytrebo",
      "Askvik", "Bjornsson", "Dalr", "Eyvindar", "Fjallar", "Grimsson", "Hallvard", "Ivarr", "Kjaran", "Lodmund",
      "Mjolnar", "Nordvik", "Oskarr", "Rannveig", "Skarphed", "Thorvik", "Unnar", "Vestmar", "Brekkur", "Heidrek",
      "Holmgard", "Kaldbak", "Rifsnes", "Solvaar", "Stormar", "Tindar", "Varsvik", "Hraunar", "Jokull", "Skjold",
    ],
  }),
  [RACE.AMARR]: Object.freeze({
    first: [
      "Aurel", "Bashir", "Cadria", "Damar", "Elara", "Farid", "Hadra", "Idris", "Jamyl", "Karsoth",
      "Lirae", "Malik", "Nadira", "Orhan", "Paladra", "Raziel", "Samira", "Tashan", "Usmah", "Yasmin",
      "Ardishapur", "Bahir", "Celeste", "Dariel", "Esra", "Gaius", "Halim", "Imara", "Jalil", "Kamira",
      "Laylah", "Marek", "Nasim", "Osiel", "Qadir", "Rahel", "Seraph", "Tamar", "Ulric", "Zahra",
      "Adair", "Basra", "Corin", "Dalia", "Ezran", "Hesper", "Ilias", "Kaled", "Mirah", "Sabine",
    ],
    last: [
      "Ardishapur", "Kador", "Kor-Azor", "Sarum", "Tash-Murkon", "Aranthal", "Belhadir", "Castellan", "Daskhar", "Erisha",
      "Falanir", "Hadrian", "Ismeer", "Jaarvis", "Khanid", "Lomarr", "Maaram", "Nefrah", "Oranthe", "Pashari",
      "Qazar", "Raqim", "Sadrah", "Tamarin", "Udrah", "Vashir", "Zarrin", "Ahranir", "Bethor", "Corvanis",
      "Durham", "Elhaim", "Gidrah", "Harrud", "Imradin", "Jorhaan", "Kemerah", "Lazarin", "Moradin", "Navar",
      "Orrim", "Pharos", "Rahmani", "Sethis", "Tavrah", "Vellan", "Yarrah", "Zelkar", "Amarin", "Domion",
    ],
  }),
  [RACE.GALLENTE]: Object.freeze({
    first: [
      "Adrien", "Bastien", "Celine", "Damien", "Elodie", "Fabien", "Gaspard", "Helene", "Isaure", "Julien",
      "Lucien", "Margaux", "Noemi", "Octave", "Pauline", "Remy", "Solene", "Thibault", "Valerie", "Yvette",
      "Amaury", "Benoit", "Clarisse", "Dorian", "Estelle", "Florent", "Gwenael", "Honore", "Ines", "Josselin",
      "Laure", "Maxence", "Nadege", "Olivier", "Perrine", "Quentin", "Romane", "Sylvain", "Tristan", "Viviane",
      "Aurele", "Blaise", "Corentin", "Delphine", "Emeric", "Fleur", "Gilles", "Lysandre", "Mathis", "Sabrina",
    ],
    last: [
      "Aubert", "Beaumont", "Chevalier", "Delacroix", "Duvolle", "Fontaine", "Garoun", "Hautbois", "Intaki", "Jourdain",
      "Lacroix", "Moreau", "Navarre", "Ollivier", "Pelletier", "Quafe", "Roden", "Sauvage", "Tremblay", "Valmont",
      "Arnaud", "Bellamy", "Corbin", "Dumont", "Esclavier", "Faucher", "Girard", "Hebert", "Lambert", "Marchand",
      "Noiret", "Perrault", "Renaud", "Sorel", "Thierry", "Vasseur", "Villeret", "Bouchard", "Carriere", "Desmarais",
      "Lefevre", "Mercier", "Picard", "Rousseau", "Sardou", "Toussaint", "Vallois", "Brissac", "Fournier", "Laurent",
    ],
  }),
});

function racePool(raceID) {
  return NAME_POOLS[Number(raceID)] || NAME_POOLS[RACE.CALDARI];
}

// Index of each first name in the current roster, for the given race pool.
function firstNameUsage(existingNames, pool) {
  const usage = new Map(pool.first.map((name) => [name.toLowerCase(), 0]));
  for (const name of existingNames || []) {
    const first = String(name || "").trim().split(/\s+/)[0].toLowerCase();
    if (usage.has(first)) usage.set(first, usage.get(first) + 1);
  }
  return usage;
}

// Returns a name that passes validation, or throws. random() is injectable
// for tests.
function generateBotName(raceID, options = {}) {
  const random = typeof options.random === "function" ? options.random : Math.random;
  const isValid = typeof options.isValid === "function" ? options.isValid : () => true;
  const pool = racePool(raceID);
  const usage = firstNameUsage(options.existingNames, pool);
  const fewest = Math.min(...usage.values());
  const leastUsed = pool.first.filter((name) => usage.get(name.toLowerCase()) === fewest);
  const pick = (list) => list[Math.floor(random() * list.length) % list.length];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const first = attempt < 100 ? pick(leastUsed) : pick(pool.first);
    const candidate = `${first} ${pick(pool.last)}`;
    if (isValid(candidate)) return candidate;
  }
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const candidate = `${pick(pool.first)} ${pick(pool.last)} ${attempt + 2}`;
    if (isValid(candidate)) return candidate;
  }
  throw new Error(`PLAYERBOT_NAME_POOL_EXHAUSTED:${raceID}`);
}

module.exports = { NAME_POOLS, RACE, generateBotName };
