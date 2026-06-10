/**
 * Unit-тесты чистой модели расшифровки (transcript-model.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SPEAKER_COLORS,
  buildSpeakerColorMap,
  speakerColorFromMap,
  speakerInitial,
  buildSpeakerInfoMap,
  resolveSpeakerLabel,
  parseLlmTranscript
} from "../app/transcript-model.js";

test("buildSpeakerColorMap: цвет по порядку первого появления, стабильный для спикера", () => {
  const segments = [
    { speakerLabel: "Спикер 1", text: "а" },
    { speakerLabel: "Спикер 2", text: "б" },
    { speakerLabel: "Спикер 1", text: "в" }
  ];
  const map = buildSpeakerColorMap(segments);

  assert.equal(map.get("Спикер 1"), SPEAKER_COLORS[0]);
  assert.equal(map.get("Спикер 2"), SPEAKER_COLORS[1]);
  assert.equal(map.size, 2);
});

test("speakerColorFromMap: guessedName приоритетнее label, fallback стабилен", () => {
  const map = new Map([["Иванов", "#111111"]]);

  const byName = speakerColorFromMap(map, { guessedName: "Иванов", speakerLabel: "Спикер 1" });
  assert.equal(byName, "#111111");

  // незнакомый спикер получает детерминированный цвет из палитры
  const fallback1 = speakerColorFromMap(map, { speakerLabel: "Незнакомец" });
  const fallback2 = speakerColorFromMap(map, { speakerLabel: "Незнакомец" });
  assert.equal(fallback1, fallback2);
  assert.ok(SPEAKER_COLORS.includes(fallback1));
});

test("speakerInitial: Спикер N → СN, имя → первые 2 буквы", () => {
  assert.equal(speakerInitial("Спикер 1"), "С1");
  assert.equal(speakerInitial("Иванов"), "ИВ");
  assert.equal(speakerInitial(null), "?");
});

test("buildSpeakerInfoMap: имена из drafts, dialogueRole по эвристике", () => {
  const drafts = [
    { id: "s1", label: "Спикер 1", guessedName: "Иванов", guessedRole: "ПМ" }
  ];
  const segments = [
    { speakerLabel: "Спикер 1", text: "Начал разговор первым" },
    { speakerLabel: "Спикер 2", text: "Говорит очень много слов больше всех в этой беседе честно" }
  ];

  const info = buildSpeakerInfoMap(drafts, segments);

  assert.equal(info.get("Спикер 1").name, "Иванов");
  assert.equal(info.get("Спикер 1").role, "ПМ");
  assert.equal(info.get("Спикер 1").dialogueRole, "начал разговор");
  assert.equal(info.get("Спикер 2").dialogueRole, "основной спикер");
});

test("resolveSpeakerLabel: имя > роль > роль-в-диалоге", () => {
  const info = new Map([
    ["Спикер 1", { name: "Иванов", role: "ПМ", dialogueRole: "начал разговор" }],
    ["Спикер 2", { name: null, role: null, dialogueRole: "участник" }]
  ]);

  assert.deepEqual(
    resolveSpeakerLabel(info, { speakerLabel: "Спикер 1" }),
    { title: "Иванов", subtitle: "ПМ" }
  );
  assert.deepEqual(
    resolveSpeakerLabel(info, { speakerLabel: "Спикер 2" }),
    { title: "Спикер 2", subtitle: "участник" }
  );
  assert.deepEqual(
    resolveSpeakerLabel(info, { speakerLabel: "Неизвестный" }),
    { title: "Неизвестный", subtitle: null }
  );
});

test("parseLlmTranscript: построчный парсинг 'Имя: текст', мусор не теряется", () => {
  const segments = parseLlmTranscript("Иванов: Привет\n\nПетров: Здравствуйте\nпросто строка без двоеточия");

  assert.equal(segments.length, 3);
  assert.deepEqual(segments[0], { speakerId: "Иванов", speakerLabel: "Иванов", text: "Привет" });
  assert.deepEqual(segments[2], { speakerId: "speaker-1", speakerLabel: "", text: "просто строка без двоеточия" });

  assert.deepEqual(parseLlmTranscript(null), []);
  assert.deepEqual(parseLlmTranscript(""), []);
});
