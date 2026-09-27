// A sending prompt has reached the child's history once its turn's user entry
// appears. Match by delivery order, never by text: identical prompts are valid.
export function visibleTaskInstructions(instructions, messages) {
  const userCount = messages.filter(m => m.role === 'user' && !m.internalTaskNotice).length;
  let startedBefore = 0;
  return instructions.filter(instruction => {
    const visible = instruction.state === 'queued' || instruction.state === 'dropped'
      || (instruction.state === 'sending' && userCount < startedBefore + 2);
    if (['sending', 'delivered'].includes(instruction.state)) startedBefore++;
    return visible;
  });
}
