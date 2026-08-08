import { clearUserDisplayName, setUserDisplayName } from "../services/userSettings.js";

export async function handleNameChangeSlashCommand(interaction) {
  const newName = interaction.options.getString("이름", true).trim();
  const displayName = await setUserDisplayName(interaction.user.id, newName);
  if (!displayName) {
    await interaction.reply({ content: "❌ 사용할 이름을 다시 입력해 주세요.", ephemeral: true });
    return;
  }
  await interaction.reply({ content: `✅ 앞으로 **${displayName}**(으)로 불러드릴게요.` });
}

export async function handleNameResetSlashCommand(interaction) {
  await clearUserDisplayName(interaction.user.id);
  await interaction.reply({ content: "✅ 저장된 이름을 초기화했습니다. 이제 디스코드 닉네임으로 불러드릴게요." });
}

export async function handleUserSettingsCommand(message, userPrompt, loadingMessage) {
  const resetMatch = userPrompt.match(/^이름(?:초기화|삭제|리셋)$/i);
  if (resetMatch) {
    await clearUserDisplayName(message.author.id);
    await loadingMessage.edit("✅ 이름을 초기화했어요. 이제 디스코드 닉네임으로 불러드릴게요.");
    return true;
  }

  const changeMatch = userPrompt.match(/^이름변경\s*(.+)$/i);
  if (changeMatch) {
    const newName = changeMatch[1].trim();
    const displayName = await setUserDisplayName(message.author.id, newName);
    if (!displayName) {
      await loadingMessage.edit("❌ 사용할 이름을 다시 입력해 주세요.");
    } else {
      await loadingMessage.edit(`✅ 앞으로 **${displayName}**(으)로 불러드릴게요.`);
    }
    return true;
  }

  return false;
}
