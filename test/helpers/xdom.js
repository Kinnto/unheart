import { JSDOM } from 'jsdom';

export function makeDoc({ handle = 'alice', posts = [] } = {}) {
  const profile = handle ? `<a data-testid="AppTabBar_Profile_Link" href="/${handle}">Profile</a>` : '';
  const dom = new JSDOM(`<!doctype html><html><body><nav>${profile}</nav><main></main></body></html>`);
  const doc = dom.window.document;
  for (const post of posts) addPost(doc, post);
  return doc;
}

export function addPost(doc, { id, liked = true, author = 'bob', quoted = null, buttons = true }) {
  const article = doc.createElement('article');
  article.setAttribute('data-testid', 'tweet');
  const quote = quoted
    ? `<div class="quote"><a href="/${quoted.author}/status/${quoted.id}"><time>Dec 1</time></a></div>`
    : '';
  const group = buttons ? `<div role="group"><button data-testid="${liked ? 'unlike' : 'like'}"></button></div>` : '';
  article.innerHTML = `<a href="/${author}"><span>@${author}</span></a>
    <a href="/${author}/status/${id}"><time datetime="2024-01-01T00:00:00.000Z">Jan 1</time></a>
    ${quote}${group}`;
  doc.querySelector('main').append(article);
  return article;
}

export function heart(doc, id) {
  for (const article of doc.querySelectorAll('article')) {
    if (article.querySelector(`a[href$="/status/${id}"] time`)) return article.querySelector('[role="group"] button');
  }
  return null;
}

export function showToast(doc, text) {
  const toast = doc.createElement('div');
  toast.setAttribute('data-testid', 'toast');
  toast.textContent = text;
  doc.body.append(toast);
  return toast;
}
