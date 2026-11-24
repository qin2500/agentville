// What the saved-account row menu offers and how it saves a flag. No DOM here: test/account-menu-ctx.test.mjs
// runs this file directly.

export const LOW_PRIORITY_TIP = 'Used only when it would otherwise go to waste: weighted down, but drained before its weekly reset';

/** The menu for one saved account: Rename, Quarantine, Low priority, a separator, then Remove (never for the signed-in account). */
export function accountMenuItems(a) {
  const items = [
    { act: 'rename', label: 'Rename', popup: true },
    { act: 'quarantine', label: a.quarantine ? 'Make regular' : 'Quarantine' },
    { act: 'lowpriority', label: a.lowPriority ? 'Make regular priority' : 'Low priority', title: LOW_PRIORITY_TIP },
  ];
  if (!a.signedIn) items.push({ sep: true }, { act: 'remove', label: 'Remove', danger: true, popup: true });
  return items;
}

/** PATCH one account (`{ quarantine }`, `{ lowPriority }` or `{ label }`), with the same error shape account.js's json() throws. */
export async function patchAccount(fetchImpl, id, body) {
  const res = await fetchImpl(`/api/accounts/${encodeURIComponent(id)}`, {
    cache: 'no-store', method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(out.error || `Server returned ${res.status}`), { code: out.code });
  return out;
}

/** The usage error the server gives when a saved account's refresh was rejected (server/accounts.mjs); only this one offers "Sign in again". */
export const isLoginExpired = (u) => typeof u?.error === 'string' && u.error.startsWith('Login expired');
