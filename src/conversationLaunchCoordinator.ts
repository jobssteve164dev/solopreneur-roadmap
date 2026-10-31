export interface ConversationLaunchCoordination<TSnapshot, TTerminal, TTarget, TResult> {
  captureSnapshot(): TSnapshot | null | undefined;
  openTerminal(snapshot: TSnapshot): Promise<TTerminal>;
  prepareRuntime(snapshot: TSnapshot): Promise<TTarget>;
  execute(input: { snapshot: TSnapshot; terminal: TTerminal; target: TTarget }): Promise<TResult>;
  releaseTerminal?(terminal: TTerminal): void | Promise<void>;
  releaseTarget?(target: TTarget): void | Promise<void>;
}

/** One launch path for Solo, roadmap steps, Flow, and governed external entrypoints. */
export async function coordinateConversationLaunch<TSnapshot, TTerminal, TTarget, TResult>(
  input: ConversationLaunchCoordination<TSnapshot, TTerminal, TTarget, TResult>
): Promise<TResult> {
  const snapshot = input.captureSnapshot();
  if (!snapshot) throw new Error('conversation_launch_snapshot_unavailable');

  const [terminalResult, targetResult] = await Promise.allSettled([
    input.openTerminal(snapshot),
    input.prepareRuntime(snapshot)
  ]);
  if (terminalResult.status === 'rejected' || targetResult.status === 'rejected') {
    if (targetResult.status === 'fulfilled') await input.releaseTarget?.(targetResult.value);
    if (terminalResult.status === 'fulfilled') await input.releaseTerminal?.(terminalResult.value);
    throw terminalResult.status === 'rejected' ? terminalResult.reason : (targetResult as PromiseRejectedResult).reason;
  }

  try {
    return await input.execute({ snapshot, terminal: terminalResult.value, target: targetResult.value });
  } finally {
    await input.releaseTarget?.(targetResult.value);
    await input.releaseTerminal?.(terminalResult.value);
  }
}
