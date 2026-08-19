import { ChannelType } from "discord.js";
import { logError, logInfo } from "../logger.js";
import { validateWord, getSubChar, getCandidates } from "./wordEngine.js";
import { pickWord, DIFFICULTY_LABELS } from "./botAI.js";
import { checkWordExists } from "./openDictService.js";
import { EconomyService } from "./economyService.js";

const HINT_TICKET = "wordchain_hint_ticket";
const PASS_TICKET = "wordchain_pass_ticket";

const TURN_TIMEOUT_MS = 60 * 1000;
const QUIT_WORDS = new Set(["포기", "그만", "항복", "종료", "끝", "gg", "GG"]);

const games = new Map();
let threadCounter = 0;

const OPENING_WORDS = ["바나나", "사과", "기차", "구름", "시계", "자동차", "비행기", "하늘", "바다", "연필", "가방", "호랑이"];

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
      const opening = userStarts ? null : OPENING_WORDS[Math.floor(Math.random() * OPENING_WORDS.length)];
      if (opening) used.add(opening);

      const game = {
        mode: "bot",
        userId: interaction.user.id,
        difficulty,
        thread,
        used,
        currentWord: opening ?? null,
        timer: null,
      };
      games.set(thread.id, game);

      const label = DIFFICULTY_LABELS[difficulty] ?? difficulty;
      await thread.send(
        `🎮 **끝말잇기 시작!** <@${interaction.user.id}>\n` +
          `난이도: **${label}**\n` +
          (opening ? `제가 먼저 할게요: **${opening}**` : "유저가 먼저 단어를 입력해 주세요!"),
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
      const candidates = await getCandidates(game.currentWord[game.currentWord.length - 1], game.used);
      const hint = candidates[Math.floor(Math.random() * candidates.length)];
      await message.reply(hint ? `💡 힌트: **${hint.word}**` : "💡 이어갈 수 있는 단어가 없어요.").catch(() => {});
    }
    return true;
  }

  if (text === ".패스권 사용" || text === ".패스") {
    const result = await useTicket(message.author.id, PASS_TICKET);
    if (!result.success) await message.reply(result.message).catch(() => {});
    else {
      const botWord = await pickWord(game.currentWord[game.currentWord.length - 1], game.used, game.difficulty);
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

  const result = await validateWord(text, game.currentWord ? game.currentWord[game.currentWord.length - 1] : null, game.used);
  if (!result.ok) {
    await message.reply(result.reason).catch(() => {});
    return true;
  }

  game.used.add(text);
  game.currentWord = text;
  const lastChar = text[text.length - 1];

  const botWord = await pickWord(lastChar, game.used, game.difficulty);
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

async function handlePvpMessage(message, game) {
  const authorId = message.author.id;
  if (!game.players.includes(authorId)) {
    await message.reply("이 대전에 참여한 유저만 플레이할 수 있어요!").catch(() => {});
    return true;
  }

  const text = message.content.trim();

  if (QUIT_WORDS.has(text)) {
    const winner = game.players.find((p) => p !== authorId);
    await endGame(message.channelId, `<@${authorId}>님이 포기했네요. <@${winner}>님의 승리! 🎉`);
    return true;
  }

  const result = await validateWord(text, game.currentWord ? game.currentWord[game.currentWord.length - 1] : null, game.used);
  if (!result.ok) {
    await message.reply(result.reason).catch(() => {});
    return true;
  }

  game.used.add(text);
  game.currentWord = text;

  const nextTurn = 1 - game.turn;
  game.turn = nextTurn;

  const nextPlayerId = game.players[nextTurn];
  const lastChar = text[text.length - 1];
  const sub = getSubChar(lastChar);
  const suffix = sub ? ` 또는 **${sub}**` : "";

  await message.channel.send(
    `<@${nextPlayerId}>님의 턴! **${text}** → **${lastChar}**(으)로 시작하세요${suffix}.\n` +
      `(게임을 끝내려면 \`포기\`, \`그만\`, \`종료\`를 입력하세요)`,
  );

  scheduleTimeout(message.channelId);
  return true;
}

export async function handleWordChainPurchaseCommand(message) {
  const text = message.content.trim();
  let product = null;
  if (text === ".힌트권 구매" || text === ".힌트구매") product = { name: "힌트권", itemId: HINT_TICKET, price: 300 };
  else if (text === ".패스권 구매" || text === ".패스구매") product = { name: "패스권", itemId: PASS_TICKET, price: 500 };
  if (!product) return false;

  const balance = await EconomyService.getBalance(message.author.id);
  if (balance < product.price) {
    await message.reply(`❌ 코인이 부족해요! (${product.name}: ${product.price} 코인 필요, 보유 코인: ${balance.toLocaleString()} 코인)`).catch(() => {});
    return true;
  }

  const charged = await EconomyService.addBalance(message.author.id, -product.price);
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

export async function handleAddWordCommand(interaction) {
  await interaction.reply({ content: "ℹ️ 현재 우리말샘 API 실시간 검증 모드로 동작 중입니다.", ephemeral: true });
}

export async function handleLookupWordCommand(interaction) {
  const word = interaction.options.getString("단어", true).trim();
  const exists = await checkWordExists(word);
  await interaction.reply(exists ? `🔍 **${word}**은(는) 우리말샘 사전에 존재합니다.` : `🔍 **${word}**은(는) 우리말샘 사전에 없어요.`);
}

export async function handleRemoveWordCommand(interaction) {
  await interaction.reply({ content: "ℹ️ 현재 우리말샘 API 실시간 검증 모드로 동작 중입니다.", ephemeral: true });
}

function sendTurnPrompt(thread, currentWord) {
  const lastChar = currentWord[currentWord.length - 1];
  const sub = getSubChar(lastChar);
  const suffix = sub ? ` 또는 **${sub}**` : "";
  return thread.send(
    `제 단어는 **${currentWord}**! **${lastChar}**(으)로 시작하는 단어를 입력하세요${suffix}.\n` +
      `(게임을 끝내려면 \`포기\`, \`그만\`, \`종료\`를 입력하세요)`,
  );
}

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
