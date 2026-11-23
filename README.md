# Unheart — Bulk Unlike for X

Turn your likes into ex-likes. Unheart is a Chrome extension that removes your likes on X (Twitter) in bulk, with one click.

- **One click.** Open your Likes and press **Unlike all**, or **try 10 first**.
- **Honest count.** A like only counts as removed once it actually stays removed.
- **Handles limits for you.** It paces itself (about one unlike per second at best) and waits automatically when X asks it to slow down.
- **You stay in control.** Pause, resume or stop at any time. Progress survives a page reload.
- **Private.** Everything runs in your browser. No account, no servers, and it never touches your password, cookies or login tokens.

## Install
- **Chrome Web Store:** coming soon.
- **From source:** download this repo, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the repo folder.

## How it works
Unheart opens your Likes page (`x.com/i/history/likes`) and clicks the heart on each liked post, the same way you would by hand. After each click it checks that the like really stayed removed before counting it. If X shows an error or the heart flips back, Unheart backs off (2, 4, 8, 16, then 30 minutes) and carries on.

Keep the tab visible while it runs; Chrome pauses hidden tabs, so Unheart pauses too and resumes when you come back.

## Permissions
- `storage`: remembers your settings (panel position, first-run confirmation) and run progress on your device.
- Access to `x.com`: to open your Likes page and click the like buttons on it.

## Development
Plain JavaScript (ES modules), no build step.

```
npm install
npm test
```

All knowledge of X's page structure lives in `content/selectors.js`. When X changes its site, that is usually the only file that needs fixing.

## License
[MIT](LICENSE)

Unheart is not affiliated with or endorsed by X Corp. Automated actions are subject to X's terms; use at your own discretion.
