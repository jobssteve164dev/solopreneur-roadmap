import { IntelligenceConversationStore } from './intelligenceChat';

export function createTelegramIntelligenceReply(
  getStore: () => IntelligenceConversationStore,
  getConversationIds: () => Record<string, string>,
  saveConversationIds: (ids: Record<string, string>) => PromiseLike<void>,
  getBindingGeneration: () => number
): (chatId: string, text: string) => Promise<string> {
  return async (chatId, text) => {
    const store = getStore();
    const generation = getBindingGeneration();
    const savedIds = getConversationIds();
    const previousId = savedIds[chatId];
    const conversation = await store.send(text, previousId && store.get(previousId) ? previousId : '');
    if (generation === getBindingGeneration()) {
      await saveConversationIds({ ...getConversationIds(), [chatId]: conversation.id });
    }
    return conversation.messages.at(-1)?.content || '';
  };
}
