const fmt = (n) => n.toLocaleString('en-US');
const likes = (n) => `${fmt(n)} ${n === 1 ? 'like' : 'likes'}`;
const line = (text, kind = 'normal') => ({ text, kind });
const action = (id, label, style = 'secondary') => ({ id, label, style });

function countdown(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function rate(state, now) {
  const minutes = (now - state.startedAt) / 60_000;
  const done = state.removed - state.removedAtStart;
  return minutes >= 0.5 && done > 0 ? `~${Math.round(done / minutes)} / min` : 'Starting…';
}

export function view(state, { now, confirming = null, resumable = null }) {
  const badge = fmt(state.removed);
  const count = line(`${fmt(state.removed)} unliked`, 'big');
  const pause = action('pause', 'Pause');
  const stop = action('stop', 'Stop');

  if (confirming !== null) {
    return {
      badge,
      lines: [line("Unliking can't be undone.")],
      actions: [action('cancel', 'Cancel'), action('confirm', confirming === Infinity ? 'Unlike all' : `Unlike ${confirming}`, 'primary')],
    };
  }

  switch (state.status) {
    case 'running':
      if (state.waitKind === 'courtesy') {
        return { badge, lines: [count, line(`Taking a short break — ${countdown(state.waitUntil - now)}`, 'muted')], actions: [pause, stop] };
      }
      return { badge, lines: [count, line(rate(state, now), 'muted')], actions: [pause, stop] };

    case 'backing-off':
      return {
        badge,
        lines: [count, line('X is limiting requests.'), line(`Resuming in ${countdown(state.waitUntil - now)}`, 'muted')],
        actions: [action('resume-now', 'Resume now'), stop],
      };

    case 'paused':
      if (state.pauseReason === 'hidden') {
        return { badge, lines: [count, line('Paused — come back to this tab to continue.', 'muted')], actions: [stop] };
      }
      return { badge, lines: [count, line('Paused.', 'muted')], actions: [action('resume', 'Resume', 'primary'), stop] };

    case 'done': {
      if (state.removed === 0 && state.failed === 0) {
        return { badge, lines: [line('You have no likes to remove.')], actions: [] };
      }
      const lines = [line(`Done — ${likes(state.removed)} removed.`, 'big')];
      const actions = [];
      if (state.failed > 0) {
        lines.push(line(`${fmt(state.failed)} didn't stick.`));
        actions.push(action('retry', 'Retry them', 'primary'));
      }
      if (state.endReason === 'limit') {
        actions.push(action('start-all', 'Unlike the rest', state.failed > 0 ? 'secondary' : 'primary'));
      } else {
        lines.push(line('X may hide some older likes. Reload the page and run again to catch them.', 'muted'));
      }
      if (state.removed >= 10) actions.push(action('share', 'Share on X'));
      return { badge, lines, actions };
    }

    case 'stopped':
      return { badge, lines: [line(`Stopped — ${likes(state.removed)} removed.`)], actions: [action('start-all', 'Continue', 'primary')] };

    case 'error':
      if (state.error === 'selectors') {
        return { badge, lines: [line("Unheart needs an update to work with X's latest change.")], actions: [] };
      }
      return { badge, lines: [line('Something went wrong.')], actions: [action('retry', 'Try again', 'primary')] };

    default:
      if (resumable) {
        return { badge: fmt(resumable), lines: [line(`${fmt(resumable)} removed so far.`)], actions: [action('resume-run', 'Resume', 'primary')] };
      }
      return {
        badge: '',
        lines: [line('Tip: keep this tab visible — put its window side by side with your other work.', 'muted')],
        actions: [action('start-all', 'Unlike all', 'primary'), action('start-10', 'or try 10 first', 'link')],
      };
  }
}
