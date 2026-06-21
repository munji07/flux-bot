import { clearUserDisplayName, setUserDisplayName } from "../services/userSettings.js";

export async function handleUserSettingsCommand(message, userPrompt, loadingMessage) {
  const changeMatch = userPrompt.match(/^이름변경\s+(.+)$/);
  if (changeMatch) {
    const displayName = setUserDisplayName(message.author.id, changeMatch[1]);
    if (!displayName) {
      await loadingMessage.edit("사용할 이름을 다시 입력해 주세요.");
      return true;
    }

    await loadingMessage.edit(`앞으로 ${displayName}(으)로 불러드릴게요.`);
    return true;
  }

  if (/^이름(?:초기화|삭제|리셋)$/i.test(userPrompt)) {
    clearUserDisplayName(message.author.id);
    await loadingMessage.edit("저장된 이름을 초기화했어요.");
    return true;
  }

  return false;
}
