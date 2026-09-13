import type { PaidInputSnapshot } from "./paid-input";

const counts: Record<string, number> = { one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, один: 1, одного: 1, одна: 1, два: 2, двух: 2, три: 3, трех: 3, трёх: 3, четыре: 4, четырех: 4, четырёх: 4, пять: 5, пяти: 5, шесть: 6, шести: 6, ein: 1, eine: 1, einen: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6 };
const unit = "(?:slides?|слайд[а-я]*|folien?)";
const count = `(?:[0-9]+|${Object.keys(counts).join("|")})`;
const quantity = new RegExp(`(?<![\\p{L}\\p{N}])(${count})\\s*[-–]?\\s*${unit}(?![\\p{L}])`, "giu");
const request = /(?:\b(?:make|use|change|turn|resize|expand|reduce|switch|want|need|have|please|instead|only)\b|давай|сдела|хочу|нужно|поменя|увелич|сократ|измени|вместо|пожалуйста|\b(?:mach|ändere|möchte|nimm|verwende|bitte|statt)\b)/iu;

export function planningFormat(snapshot: PaidInputSnapshot) {
  const current = snapshot.publication.slideCount;
  if (!snapshot.publication.creation?.plan || snapshot.kind !== "prepare") return { current, proposed: current, clarify: false };
  const message = (snapshot.publication.messages.filter(item => item.role === "user").at(-1)?.text.trim() ?? "").replace(/"[^"]*"|“[^”]*”|«[^»]*»/gu, "");
  const negated = /(?:\b(?:not|don't|never)\b|(?<!\p{L})не\s|\b(?:nicht|kein)\b)/iu.test(message);
  if (/(?:\b(?:make|switch|turn|use|want)\b.*\bsingle[- ]image(?:\s+post)?\b)/iu.test(message)) return { current, proposed: negated ? current : 1, clarify: negated };
  const matches = [...message.matchAll(quantity)];
  const standalone = new RegExp(`^${count}\\s*[-–]?\\s*${unit}[.!]?$`, "iu").test(message);
  if (!matches.length) return { current, proposed: current, clarify: /(?:\b(?:more|fewer)\s+slides\b|(?:больше|меньше)\s+слайд|(?:mehr|weniger)\s+Folien)/iu.test(message) };
  if (!request.test(message) && !standalone) return { current, proposed: current, clarify: false };
  const values = [...new Set(matches.map(match => counts[match[1].toLowerCase()] ?? Number(match[1])))];
  if (values.length !== 1 || negated || values[0] < 1 || values[0] > 6) return { current, proposed: current, clarify: true };
  return { current, proposed: values[0], clarify: false };
}
