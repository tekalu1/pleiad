export function codexLimitError(error) {
  const message = String(error?.message ?? error?.type ?? error ?? '');
  return /(?:usage|rate|request) limit|quota|too many requests/i.test(message);
}
