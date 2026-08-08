import { ChannelType } from "discord.js";
import { logError, logInfo } from "../logger.js";
import { validateWord, hasContinuation, getSubChar, getCandidates, getDanger } from "./wordEngine.js";
import { pickWord, DIFFICULTY_LABELS } from "./botAI.js";
import { addWord, getFirstChars, getWordsByFirstChar, getRandomWord, getWordInfo, isKnownWord, removeWord } from "./wordCache.js";
import { EconomyService } from "./economyService.js";

const HINT_TICKET = "wordchain_hint_ticket";
const PASS_TICKET = "wordchain_pass_ticket";

/**
 * GameManager
 *
 * Discord 연동을 담당하는 최상위 게임 관리 모듈.
 * - 게임 생성 (스레드 생성, 시작 단어 선정)
 * - 게임 종료 (승패 판정, 스레드 보관)
 * - 턴 관리 (유저 입력 검증 → 봇 응답 → 시간 초과)
 *
 * 순수 로직(단어 검증/후보/위험도/난이도)은
 * wordEngine.js와 botAI.js에 위임한다.
 */

const TURN_TIMEOUT_MS = 60 * 1000;
const QUIT_WORDS = new Set(["포기", "그만", "항복", "종료", "끝", "gg", "GG"]);

/** threadId → 게임 상태 Map */
const games = new Map();
let threadCounter = 0;

/**
 * 끝말잇기 게임을 시작한다. 텍스트 채널에 스레드를 만들고 그 안에서 진행한다.
 * - opponentId가 없으면: 봇과 1:1 (난이도 적용)
 * - opponentId가 있으면: 유저 vs 유저 대전
 * @param {import("discord.js").Interaction} interaction
 * @param {string} difficulty 난이도 (easy/normal/hard/impossible)
 * @param {string|null} opponentId 상대 유저 ID (PvP 전용)
 */
export async function handleWordChainCommand(interaction, difficulty, opponentId, userStarts = false) {
  const receivedAt = Date.now();
  await interaction.deferReply();
  logInfo("wordchain_defer_completed", {
    interactionId: interaction.id,
    elapsedMs: Date.now() - receivedAt,
  });

  try {
    const channel = interaction.channel;
    if (!channel || !channel.isTextBased() || channel.isThread()) {
      await interaction.editReply("❌ 텍스트 채널에서만 끝말잇기를 시작할 수 있어요.");
      return;
    }

    if (opponentId === interaction.user.id) {
      await interaction.editReply("❌ 자기 자신과는 대전할 수 없어요!");
      return;
    }

    const name = `끝말잇기 ${(++threadCounter).toString().padStart(3, "0")}`;
    const thread = await channel.threads.create({
      name,
      type: ChannelType.PublicThread,
      autoArchiveDuration: 60,
    });

    const used = new Set();

    if (opponentId) {
      const game = {
        mode: "pvp",
        players: [interaction.user.id, opponentId],
        turn: 0,
        used,
        currentWord: null,
        thread,
        timer: null,
      };
      games.set(thread.id, game);

      const p1 = interaction.user.id;
      const p2 = opponentId;
      await thread.send(
        `🎮 **유저 대전 끝말잇기 시작!**\n` +
          `<@${p1}> 🆚 <@${p2}>\n` +
          `<@${p1}>님이 **첫 단어**를 입력하세요. (이어올 필요 없이 자유롭게)` +
          `\n게임을 끝내려면 \`포기\`, \`그만\`, \`종료\`를 입력하세요.`,
      );
    } else {
      const opening = userStarts ? null : pickOpeningWord(used, difficulty);
      if (opening) used.add(opening.word);

      const game = {
        mode: "bot",
        userId: interaction.user.id,
        difficulty,
        thread,
        used,
        currentWord: opening?.word ?? null,
        timer: null,
      };
      games.set(thread.id, game);

      const label = DIFFICULTY_LABELS[difficulty] ?? difficulty;
      await thread.send(
        `🎮 **끝말잇기 시작!** <@${interaction.user.id}>\n` +
          `난이도: **${label}**\n` +
          opening ? `제가 먼저 할게요: **${opening.word}**` : "유저가 먼저 단어를 입력해 주세요!",
      );
      if (opening) {
        await sendTurnPrompt(thread, game.currentWord);
        scheduleTimeout(thread.id);
      }
    }

    await interaction.editReply(`✅ 끝말잇기 스레드를 만들었어요: ${thread}`);
  } catch (err) {
    logError("wordchain_start_failed", interaction.guildId, err, {
      userId: interaction.user.id,
    });
    await interaction.editReply("❌ 끝말잇기를 시작하는 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.");
  }
}

/**
 * 게임 스레드에서 온 메시지를 처리한다.
 * 게임과 관련 없는 채널/메시지면 false를 반환해 다른 핸들러에게 넘긴다.
 * @param {import("discord.js").Message} message
 * @returns {Promise<boolean>} 처리했으면 true
 */
export async function handleWordChainMessage(message) {
  if (await handleWordChainPurchaseCommand(message)) return true;

  const game = games.get(message.channelId);
  if (!game) return false;

  if (message.author.bot) return true;

  if (game.mode === "pvp") return handlePvpMessage(message, game);

  if (message.author.id !== game.userId) {
    await message.reply("이 게임은 게임을 시작한 유저만 참여할 수 있어요!").catch(() => {});
    return true;
  }

  const text = message.content.trim();

  if (QUIT_WORDS.has(text)) {
    await endGame(message.channelId, "게임을 포기하셨네요. 제가 이겼어요! 👑");
    return true;
  }

  if (text === ".힌트권 사용" || text === ".힌트") {
    const result = await useTicket(message.author.id, HINT_TICKET);
    if (!result.success) await message.reply(result.message).catch(() => {});
    else {
      const candidates = getCandidates(game.currentWord[game.currentWord.length - 1], game.used);
      const hint = candidates[Math.floor(Math.random() * candidates.length)];
      await message.reply(hint ? `💡 힌트: **${hint.word}**` : "💡 이어갈 수 있는 단어가 없어요.").catch(() => {});
    }
    return true;
  }

  if (text === ".패스권 사용" || text === ".패스") {
    const result = await useTicket(message.author.id, PASS_TICKET);
    if (!result.success) await message.reply(result.message).catch(() => {});
    else {
      const botWord = pickWord(game.currentWord[game.currentWord.length - 1], game.used, game.difficulty);
      if (!botWord) await endGame(message.channelId, "패스할 단어가 없어 제가 졌어요! 🎉");
      else {
        game.used.add(botWord.word);
        game.currentWord = botWord.word;
        await message.channel.send(`🎫 패스권 사용! **${botWord.word}**`);
        await sendTurnPrompt(message.channel, game.currentWord);
        scheduleTimeout(message.channelId);
      }
    }
    return true;
  }

  const result = game.currentWord
    ? validateWord(text, game.currentWord[game.currentWord.length - 1], game.used)
    : validateOpeningWord(text, game.used);
  if (!result.ok) {
    await message.reply(result.reason).catch(() => {});
    return true;
  }

  game.used.add(text);
  game.currentWord = text;
  const lastChar = text[text.length - 1];

  // 봇이 이어갈 단어가 없으면 유저 승리
  const botWord = pickWord(lastChar, game.used, game.difficulty);
  if (!botWord) {
    await endGame(message.channelId, `어? **${text}** 뒤에 이을 단어가 없네요... 당신의 승리입니다! 🎉`);
    return true;
  }

  game.used.add(botWord.word);
  game.currentWord = botWord.word;
  await message.channel.send(`**${botWord.word}**`);
  await sendTurnPrompt(message.channel, game.currentWord);
  scheduleTimeout(message.channelId);

  return true;
}

function validateOpeningWord(text, used) {
  if (!/^[가-힣]{2,}$/.test(text)) return { ok: false, reason: "두 글자 이상의 한글 단어를 입력해 주세요!" };
  if (used.has(text)) return { ok: false, reason: `**${text}**은(는) 이미 사용한 단어예요!` };
  if (!isKnownWord(text)) return { ok: false, reason: `**${text}**은(는) 사전에 없는 단어예요!` };
  return { ok: true };
}

/** 유저 대 유저 대전 모드의 메시지를 처리한다. */
async function handlePvpMessage(message, game) {
  const authorId = message.author.id;
  if (!game.players.includes(authorId)) {
    await message.reply("이 대전에 참여한 유저만 플레이할 수 있어요!").catch(() => {});
    return true;
  }

  const currentPlayerId = game.players[game.turn];
  const text = message.content.trim();

  if (QUIT_WORDS.has(text)) {
    const winner = game.players.find((p) => p !== authorId);
    await endGame(message.channelId, `<@${authorId}>님이 포기했네요. <@${winner}>님의 승리! 🎉`);
    return true;
  }

  if (authorId !== currentPlayerId) {
    await message.reply(`<@${currentPlayerId}>님의 차례예요! 잠시만 기다려주세요.`).catch(() => {});
    return true;
  }

  // 첫 단어는 이어올 필요 없이 자유 입력
  if (!game.currentWord) {
    if (!/^[가-힣]{2,}$/.test(text)) {
      await message.reply("두 글자 이상의 한글 단어를 입력해 주세요!").catch(() => {});
      return true;
    }
    if (game.used.has(text)) {
      await message.reply(`**${text}**은(는) 이미 사용한 단어예요!`).catch(() => {});
      return true;
    }
    if (!isKnownWord(text)) {
      await message.reply(`**${text}**은(는) 사전에 없는 단어예요!`).catch(() => {});
      return true;
    }
  } else {
    const result = validateWord(text, game.currentWord[game.currentWord.length - 1], game.used);
    if (!result.ok) {
      await message.reply(result.reason).catch(() => {});
      return true;
    }
  }

  game.used.add(text);
  game.currentWord = text;

  // 턴을 상대에게 넘긴다. 상대가 이어갈 단어가 없으면 방금 입력한 유저가 승리.
  game.turn = 1 - game.turn;
  const nextPlayer = game.players[game.turn];
  if (!hasContinuation(text[text.length - 1], game.used)) {
    await endGame(
      message.channelId,
      `어? **${text}** 뒤에 이을 단어가 없네요... <@${game.players[1 - game.turn]}>님의 승리! 🎉`,
    );
    return true;
  }

  const sub = getSubChar(text[text.length - 1]);
  const suffix = sub ? ` 또는 **${sub}**` : "";
  await message.channel.send(
    `**${text}**! → <@${nextPlayer}>님 차례예요. **${text[text.length - 1]}**(으)로 시작하는 단어를 입력하세요${suffix}.`,
  );
  scheduleTimeout(message.channelId);
  return true;
}

export async function handleWordChainPurchaseCommand(message) {
  const text = message.content.trim();
  const products = {
    ".힌트권 구매": { itemId: HINT_TICKET, name: "힌트권", price: 500 },
    ".패스권 구매": { itemId: PASS_TICKET, name: "패스권", price: 1000 },
  };
  const product = products[text];
  if (!product) return false;

  const user = await EconomyService.getOrCreateUser(message.author.id);
  if (user.coins < product.price) {
    await message.reply(`❌ 코인이 부족해요. ${product.name}은(는) **${product.price.toLocaleString()} 코인**이 필요합니다.`).catch(() => {});
    return true;
  }
  const charged = await EconomyService.updateCoins(message.author.id, -product.price);
  if (!charged.success) {
    await message.reply("❌ 구매 처리 중 문제가 발생했어요. 잠시 후 다시 시도해주세요.").catch(() => {});
    return true;
  }
  await EconomyService.updateInventory(message.author.id, product.itemId, 1);
  await message.reply(`✅ ${product.name} 1개를 구매했어요. 남은 잔액: **${charged.balance.toLocaleString()} 코인**`).catch(() => {});
  return true;
}

async function useTicket(userId, itemId) {
  const inventory = await EconomyService.getInventory(userId);
  const item = inventory.find((entry) => entry.item_id === itemId);
  if (!item || item.quantity < 1) {
    return { success: false, message: "❌ 해당 이용권이 없어요. 먼저 구매해주세요." };
  }
  const updated = await EconomyService.updateInventory(userId, itemId, -1);
  return updated ? { success: true } : { success: false, message: "❌ 이용권 사용 중 문제가 발생했어요." };
}

/** 게임 시작 단어를 선정한다. 유저가 바로 이어갈 수 있으면서, 한방단어로 이기기 어려운 단어를 고른다. */
function pickOpeningWord(used, difficulty) {
  // 시작이 느려지지 않도록 전체 사전을 한 번에 평탄화하지 않고,
  // 시작 글자 버킷을 무작위 순회하며 이어질 수 있는 안전한 단어를 빠르게 찾는다.
  const firstChars = shuffleArray(getFirstChars());
  for (const first of firstChars) {
    const unused = getWordsByFirstChar(first).filter((w) => !used.has(w.word));
    if (!unused.length) continue;
    // 시작 단어를 고를 때 전체 사전의 킬러 수를 계산하면 첫 실행이 지나치게 무거워진다.
    // 후보를 제한하고 다음 수가 존재하는지만 확인해, 트리거 직후 프로세스가 과부하되지 않게 한다.
    const safeWords = shuffleArray(unused)
      .filter((word) => hasContinuation(word.last, used))
      .map((word) => ({ word, danger: getDanger(word, used) }));
    if (safeWords.length) return pickOpeningByDifficulty(safeWords, difficulty).word;
  }
  // 안전한 단어를 못 찾으면 아무 한방으로 이어갈 수 있는 단어로 대체한다.
  for (const first of shuffleArray(firstChars)) {
    for (const word of getWordsByFirstChar(first)) {
      if (!used.has(word.word) && hasContinuation(word.last, used)) return word;
    }
  }
  return getRandomWord();
}

function pickOpeningByDifficulty(scored, difficulty) {
  if (difficulty === "easy") {
    return scored[Math.floor(Math.random() * scored.length)];
  }

  const sorted = [...scored].sort((a, b) => a.danger - b.danger);
  const poolSize = difficulty === "normal" ? Math.ceil(sorted.length * 0.5) : Math.min(10, sorted.length);
  return sorted[Math.floor(Math.random() * poolSize)];
}

function shuffleArray(arr) {
  if (!arr.length) return arr;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export async function handleAddWordCommand(interaction) {
  if (interaction.user.id !== "1269575955626725390") {
    await interaction.reply({ content: "❌ 관리자만 사용할 수 있는 명령어입니다.", ephemeral: true });
    return;
  }
  const word = interaction.options.getString("단어", true).trim();
  if (!/^[가-힣]{2,}$/.test(word)) {
    await interaction.reply({ content: "❌ 두 글자 이상의 한글 단어만 추가할 수 있어요.", ephemeral: true });
    return;
  }
  const added = addWord(word);
  await interaction.reply(added ? `✅ **${word}**을(를) 끝말잇기 사전에 추가했어요.` : `ℹ️ **${word}**은(는) 이미 사전에 있어요.`);
}

export async function handleLookupWordCommand(interaction) {
  const word = interaction.options.getString("단어", true).trim();
  if (!/^[가-힣]{2,}$/.test(word)) {
    await interaction.reply({ content: "❌ 두 글자 이상의 한글 단어를 입력해 주세요.", ephemeral: true });
    return;
  }
  const info = getWordInfo(word);
  if (!info) {
    await interaction.reply({ content: `🔍 **${word}**은(는) 끝말잇기 사전에 없어요.` });
    return;
  }
  const typeLabel = { 0: "일반", 1: "명사", 2: "동사", 3: "형용사" }[info.type] ?? "일반";
  await interaction.reply({
    content: [
      `🔍 **${info.word}**`,
      "",
      `- 시작 글자: \`${info.first}\``,
      `- 마지막 글자: \`${info.last}\``,
      `- 글자 수: \`${info.length}자\``,
      `- 품사: \`${typeLabel}\``,
      `- 사용 횟수: \`${info.hit ?? 0}회\``,
    ].join("\n"),
  });
}

export async function handleRemoveWordCommand(interaction) {
  if (interaction.user.id !== "1269575955626725390") {
    await interaction.reply({ content: "❌ 관리자만 사용할 수 있는 명령어입니다.", ephemeral: true });
    return;
  }
  const word = interaction.options.getString("단어", true).trim();
  if (!/^[가-힣]{2,}$/.test(word)) {
    await interaction.reply({ content: "❌ 두 글자 이상의 한글 단어만 제거할 수 있어요.", ephemeral: true });
    return;
  }
  const removed = removeWord(word);
  await interaction.reply(removed ? `🗑️ **${word}**을(를) 끝말잇기 사전에서 제거했어요.` : `❌ **${word}**은(는) 사전에 없어요.`);
}

/** 턴 안내 메시지를 전송하고 60초 타임아웃을 등록한다. */
function sendTurnPrompt(thread, currentWord) {
  const lastChar = currentWord[currentWord.length - 1];
  const sub = getSubChar(lastChar);
  const suffix = sub ? ` 또는 **${sub}**` : "";
  return thread.send(
    `제 단어는 **${currentWord}**! **${lastChar}**(으)로 시작하는 단어를 입력하세요${suffix}.\n` +
      `(게임을 끝내려면 \`포기\`, \`그만\`, \`종료\`를 입력하세요)`,
  );
}

/** 턴 타임아웃을 등록한다. (기존 타이머는 초기화) */
function scheduleTimeout(threadId) {
  const game = games.get(threadId);
  if (!game) return;
  clearTimeout(game.timer);
  game.timer = setTimeout(() => {
    const msg =
      game.mode === "pvp"
        ? `⏱️ **시간 초과!** <@${game.players[game.turn]}>님이 제시간에 답하지 못해 <@${game.players[1 - game.turn]}>님의 승리! 👑`
        : "⏱️ **시간 초과!** 제 시간 안에 답하지 못해 제가 이겼어요. 👑";
    endGame(threadId, msg);
  }, TURN_TIMEOUT_MS);
}

/** 게임을 종료하고 스레드를 보관 처리한다. */
async function endGame(threadId, message) {
  const game = games.get(threadId);
  if (!game) return;
  clearTimeout(game.timer);
  games.delete(threadId);

  try {
    const thread = game.thread;
    await thread.send(message);
    await thread.setArchived(true);
  } catch (err) {
    logError("wordchain_end_failed", null, err, { threadId });
  }
}
