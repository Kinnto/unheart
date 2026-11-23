const ARTICLE = 'article[data-testid="tweet"]';
const LIKED = '[data-testid="unlike"]';
const UNLIKED = '[data-testid="like"]';
const PROFILE_LINK = 'a[data-testid="AppTabBar_Profile_Link"]';
const TOAST = '[data-testid="toast"]';
const ERROR_TEXT = /went wrong|try again|limit/i;

export function getOwnHandle(doc = document) {
  const href = doc.querySelector(PROFILE_LINK)?.getAttribute('href') ?? '';
  return href.match(/^\/([A-Za-z0-9_]{1,15})$/)?.[1] ?? null;
}

export const LIKES_PATH = '/i/history/likes';

export function isOwnLikesPage(pathname, handle) {
  const path = pathname.toLowerCase().replace(/\/+$/, '');
  if (path === LIKES_PATH) return true;
  return Boolean(handle) && path === `/${handle.toLowerCase()}/likes`;
}

export function getPostId(article) {
  for (const link of article.querySelectorAll('a[href*="/status/"]')) {
    if (!link.querySelector('time')) continue;
    const id = link.getAttribute('href').match(/\/status\/(\d+)/)?.[1];
    if (id) return id;
  }
  return null;
}

function likedState(article) {
  if (article.querySelector(LIKED)) return true;
  if (article.querySelector(UNLIKED)) return false;
  return null;
}

export function listPosts(doc = document) {
  return [...doc.querySelectorAll(ARTICLE)]
    .map((article) => ({ id: getPostId(article), liked: likedState(article), article }))
    .filter((post) => post.id);
}

export function lastArticle(doc = document) {
  const articles = doc.querySelectorAll(ARTICLE);
  return articles.length ? articles[articles.length - 1] : null;
}

export function findPost(id, doc = document) {
  return listPosts(doc).find((post) => post.id === id) ?? null;
}

export function likedButtonOf(article) {
  return article.querySelector(LIKED);
}

export function errorToast(doc = document) {
  const toast = doc.querySelector(TOAST);
  return toast && ERROR_TEXT.test(toast.textContent?.trim() ?? '') ? toast : null;
}

export function findErrorToast(doc = document) {
  return errorToast(doc)?.textContent.trim() ?? null;
}

export function looksBroken(doc = document) {
  if (doc.querySelectorAll(ARTICLE).length === 0) return false;
  return listPosts(doc).every((post) => post.liked === null);
}

export function findTimelineRetry(doc = document) {
  const scope = doc.querySelector('main') ?? doc;
  for (const el of scope.querySelectorAll('button, [role="button"]')) {
    if (el.textContent.trim() === 'Retry') return el;
  }
  return null;
}
