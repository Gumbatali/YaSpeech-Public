import test from "node:test";
import assert from "node:assert/strict";
import { assignSpeakerNames } from "../src/infrastructure/yc-yandex-gpt-gateway.js";

const vote = (label, guessedName) => ({ id: label, label, guessedName });
const run = (perSample) => perSample.map((s) => Object.entries(s).map(([l, n]) => vote(l, n)));
const byLabel = (drafts) => Object.fromEntries(drafts.map((d) => [d.label, d]));

test("assignSpeakerNames: единогласное имя получает high", () => {
  const samples = run(Array(7).fill({ A: "Артем", B: "Семен" }));
  const r = byLabel(assignSpeakerNames(samples, [{ name: "Артем" }, { name: "Семен" }]));
  assert.equal(r.A.guessedName, "Артем");
  assert.equal(r.A.confidence, "high");
  assert.equal(r.A.inRoster, true);
});

test("assignSpeakerNames: одно имя достаётся только сильнейшей метке", () => {
  const samples = run(Array(7).fill({ A: "Артем", B: "Артем" }));
  samples[0][1].guessedName = null;
  const r = byLabel(assignSpeakerNames(samples));
  assert.equal(r.A.guessedName, "Артем");
  assert.equal(r.B.guessedName, null);
});

test("assignSpeakerNames: проигравшая метка берёт запасное имя только с долей >= 0.5", () => {
  const split = (artem, vlad) => run([
    ...Array(artem).fill({ A: "Артем", B: "Артем" }),
    ...Array(vlad).fill({ A: "Артем", B: "Влад" })
  ]);
  assert.equal(byLabel(assignSpeakerNames(split(4, 4))).B.guessedName, "Влад");
  assert.equal(byLabel(assignSpeakerNames(split(5, 3))).B.guessedName, null);
});

test("assignSpeakerNames: ё/е не различаются, имя вне ростера помечается", () => {
  const samples = run([{ A: "Семён" }, { A: "Семен" }, { A: "Семен" }]);
  const r = byLabel(assignSpeakerNames(samples, [{ name: "Влад" }]))
  assert.equal(r.A.votesForWinner, 3);
  assert.equal(r.A.inRoster, false);
});

test("assignSpeakerNames: имя по первому слову полного имени из ростера считается ростерным", () => {
  const r = byLabel(assignSpeakerNames(run([{ A: "Настя" }]), [{ name: "Настя Филатова" }]));
  assert.equal(r.A.inRoster, true);
});
