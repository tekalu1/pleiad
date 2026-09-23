// IME owns navigation and confirmation keys during composition.
// Some browsers report the final composition key only as keyCode 229.
export const isComposingKey = event => event.isComposing || event.keyCode === 229;
