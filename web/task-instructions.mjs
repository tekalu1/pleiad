// A sending prompt has reached the child's history once its turn's user entry
// appears. Match by delivery order, never by text: identical prompts are valid.
export function visibleTaskInstructions(instructions, messages) {
  const userCount = messages.filter(m => m.role === 'user' && !m.internalTaskNotice).length;
  return instructions.filter((instruction, index) => instruction.state === 'queued'
    || (['sending', 'dropped'].includes(instruction.state) && userCount < index + 2));
}
