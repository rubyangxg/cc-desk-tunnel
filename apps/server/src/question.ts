// What a user message cost, added up over the turns the CLI took to answer it. A background task that finishes starts
// a turn of its own, without a user message; that turn carries on the question before it, so the figures are running
// totals. The requests its subagents make after a turn has ended carry the id of the latest prompt, which is why a
// question is counted by the prompts of all its turns.
export type TurnFigures = {
  // The user message the turn answered; none for a turn that a background task started.
  messageId?: string;
  startedAt: number;
  requests: number;
  outputTokens: number;
  promptIds: string[];
};

export function questionTally() {
  let question: TurnFigures | undefined;
  // Adds a turn that has just ended to its question and returns the question's figures so far.
  return (turn: TurnFigures): TurnFigures => {
    if (!question || turn.messageId)
      question = { ...turn, requests: 0, outputTokens: 0, promptIds: [] };
    question.requests += turn.requests;
    question.outputTokens += turn.outputTokens;
    question.promptIds.push(...turn.promptIds);
    return { ...question, promptIds: [...question.promptIds] };
  };
}

// Runs the tasks it is given one after another, in the order given, whatever each takes; a task that fails does not hold
// back the next. A report that waits for requests to arrive must not be overtaken by the report of the turn after it.
export function inOrder() {
  let last: Promise<void> = Promise.resolve();
  return (task: () => Promise<void>) => (last = last.then(task).catch(() => {}));
}
