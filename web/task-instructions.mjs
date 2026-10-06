// A sending prompt has reached the child's history once its turn's user entry
// appears. Match by delivery order, never by text: identical prompts are valid.
// totalUsers: the child's user-turn count over the whole conversation, when the
// messages are only its tail (a host task whose older messages were omitted).
export function visibleTaskInstructions(instructions, messages, totalUsers = null) {
  const userCount = Number.isInteger(totalUsers) ? totalUsers : messages.filter(m => m.role === 'user' && !m.internalTaskNotice).length;
  let startedBefore = 0;
  return instructions.filter(instruction => {
    const visible = instruction.state === 'queued' || instruction.state === 'dropped'
      || (instruction.state === 'sending' && userCount < startedBefore + 2);
    if (['sending', 'delivered'].includes(instruction.state)) startedBefore++;
    return visible;
  });
}
