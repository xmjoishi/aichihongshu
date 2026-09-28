import { createContext, useContext } from "react";

/** In-memory navigation state; intentionally discarded when the app closes. */
export const MenuDestinationContext = createContext<(path: string) => string>((path) => path);
export const useMenuDestination = () => useContext(MenuDestinationContext);

export function primaryMenu(path: string): string {
  if (path === "/accounts/pool") return path;
  if (path === "/accounts" || path === "/search") return "/inspire";
  if (path === "/publish") return "/notes";
  return `/${path.split("/")[1] ?? ""}`;
}
