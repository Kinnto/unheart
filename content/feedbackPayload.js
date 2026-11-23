export const MAX_MESSAGE = 1000;
export const CHOICES = Object.freeze(['works', 'broken']);

export function buildFeedbackPayload({ key, choice, message, version }) {
  if (!key || !CHOICES.includes(choice)) return null;
  const text = typeof message === 'string' ? message.trim().slice(0, MAX_MESSAGE) : '';
  return {
    access_key: key,
    subject: `Unheart feedback: ${choice}`,
    from_name: 'Unheart',
    choice,
    message: text,
    version,
    source: 'panel',
  };
}
