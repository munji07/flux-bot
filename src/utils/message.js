import { DISCORD_MESSAGE_LIMIT, SAFE_MESSAGE_LIMIT } from "../config.js";

export function getDisplayName(message) {
  const name =
    message.member?.displayName ||
    message.author.globalName ||
    message.author.username ||
    "친구";

  return name.replace(/[\r\n[\]]/g, " ").trim().slice(0, 80) || "친구";
}


export async function sendChunkedAnswer(message, loadingMessage, answer) {
  const chunks = splitDiscordMessage(answer);
  const [firstChunk, ...restChunks] = chunks;

  await loadingMessage.edit(firstChunk).catch(async () => {
    await message.channel.send(firstChunk);
  });

  for (const chunk of restChunks) {
    await message.channel.send(chunk);
  }
}

export function getImageAttachmentUrls(message) {
  return [...message.attachments.values()]
    .filter((attachment) => isImageAttachment(attachment))
    .map((attachment) => attachment.url)
    .slice(0, 5);
}

export function createUserMessageContent(userName, userPrompt, imageUrls = []) {
  const imageText = imageUrls.length > 0 ? `\n[이미지 첨부: ${imageUrls.join(", ")}]` : "";

  return `[유저 이름: ${userName}]\n${userPrompt}${imageText}`;
}

function isImageAttachment(attachment) {
  if (attachment.contentType?.startsWith("image/")) return true;

  return /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(attachment.name ?? attachment.url);
}

function splitDiscordMessage(text) {
  if (text.length <= DISCORD_MESSAGE_LIMIT) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= SAFE_MESSAGE_LIMIT) {
      chunks.push(remaining);
      break;
    }

    const slice = remaining.slice(0, SAFE_MESSAGE_LIMIT);
    const splitAt = findBestSplitIndex(slice);

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

function findBestSplitIndex(text) {
  const preferredBreaks = ["\n\n", "\n", ". ", "! ", "? ", " "];

  for (const marker of preferredBreaks) {
    const index = text.lastIndexOf(marker);
    if (index >= SAFE_MESSAGE_LIMIT * 0.5) {
      return index + marker.length;
    }
  }

  return SAFE_MESSAGE_LIMIT;
}
