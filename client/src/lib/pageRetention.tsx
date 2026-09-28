import { createContext, useContext } from "react";

/** In-memory navigation state; intentionally discarded when the app closes. */
export const MenuDestinationContext = createContext<(path: string) => string>((path) => path);
export const useMenuDestination = () => useContext(MenuDestinationContext);

export const MAX_RETAINED_PAGES = 18;

export interface RetainedPage<TLocation = unknown, TAccount = unknown> {
  location: TLocation;
  account: TAccount;
}

/** Store the latest visited page and evict the least recently visited page above the cap. */
export function retainPage<TLocation, TAccount>(
  pages: Record<string, RetainedPage<TLocation, TAccount>>,
  key: string,
  page: RetainedPage<TLocation, TAccount>,
  limit = MAX_RETAINED_PAGES,
): Record<string, RetainedPage<TLocation, TAccount>> {
  const next = { ...pages };
  // Reinsert so object order represents least- to most-recently-used.
  delete next[key];
  next[key] = page;
  while (Object.keys(next).length > Math.max(1, limit)) {
    delete next[Object.keys(next)[0]];
  }
  return next;
}

export function primaryMenu(path: string): string {
  if (path === "/accounts/pool") return path;
  if (path === "/accounts" || path === "/search") return "/inspire";
  if (path === "/publish") return "/notes";
  return `/${path.split("/")[1] ?? ""}`;
}
