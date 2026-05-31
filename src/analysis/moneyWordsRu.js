/**
 * Целая сумма BYN прописью (рус.) для строки вида «12 345,67 (…)».
 */

/**
 * @param {number} num 1..999
 * @param {"f"|"m"} gender
 */
function tripletWords(num, gender) {
  const onesFem = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
  const onesMasc = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
  const tens = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
  const teens = [
    "десять",
    "одиннадцать",
    "двенадцать",
    "тринадцать",
    "четырнадцать",
    "пятнадцать",
    "шестнадцать",
    "семнадцать",
    "восемнадцать",
    "девятнадцать",
  ];
  const hundreds = [
    "",
    "сто",
    "двести",
    "триста",
    "четыреста",
    "пятьсот",
    "шестьсот",
    "семьсот",
    "восемьсот",
    "девятьсот",
  ];

  const h = Math.floor(num / 100);
  const t = Math.floor((num % 100) / 10);
  const o = num % 10;
  /** @type {string[]} */
  const p = [];
  if (h) p.push(hundreds[h]);
  if (t === 1) {
    p.push(teens[o]);
  } else {
    if (t) p.push(tens[t]);
    if (o) p.push(gender === "f" ? onesFem[o] : onesMasc[o]);
  }
  return p.filter(Boolean).join(" ");
}

/**
 * @param {number} num
 * @param {[string, string, string]} forms [one, few, many]
 */
function pluralRu(num, forms) {
  const mod10 = num % 10;
  const mod100 = num % 100;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

/**
 * @param {number} n целое неотрицательное
 */
export function integerBynAmountWords(n) {
  if (!Number.isFinite(n) || n < 0) return "";
  const x = Math.floor(n);
  if (x === 0) return "ноль белорусских рублей";

  /** Триады справа налево: единицы, тысячи, миллионы, миллиарды */
  /** @type {number[]} */
  const g = [];
  let rest = x;
  for (let i = 0; i < 4; i++) {
    g.push(rest % 1000);
    rest = Math.floor(rest / 1000);
  }

  /** @type {string[]} */
  const chunks = [];

  if (g[3]) {
    chunks.push(
      `${tripletWords(g[3], "m")} ${pluralRu(g[3], ["миллиард", "миллиарда", "миллиардов"])}`,
    );
  }
  if (g[2]) {
    chunks.push(
      `${tripletWords(g[2], "m")} ${pluralRu(g[2], ["миллион", "миллиона", "миллионов"])}`,
    );
  }
  if (g[1]) {
    chunks.push(`${tripletWords(g[1], "f")} ${pluralRu(g[1], ["тысяча", "тысячи", "тысяч"])}`);
  }

  const rubForms = ["белорусский рубль", "белорусских рубля", "белорусских рублей"];
  if (g[0]) {
    chunks.push(`${tripletWords(g[0], "m")} ${pluralRu(g[0], rubForms)}`);
  } else if (chunks.length) {
    chunks.push("белорусских рублей");
  }

  return chunks.join(" ").replace(/\s+/g, " ").trim();
}
