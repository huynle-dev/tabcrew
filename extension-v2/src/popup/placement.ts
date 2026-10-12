import { loadPlacement, parsePlacement, savePlacement } from "../config.js";

/** The bits of an `<input type="radio">` the placement setting uses. */
export interface RadioLike {
  value: string;
  checked: boolean;
  addEventListener(type: "change", listener: () => void): void;
}

/**
 * Check the radio matching the stored placement and persist the user's choice on change. The
 * setting only applies to sessions that have not created a tab yet.
 */
export async function bindPlacementRadios(radios: readonly RadioLike[]): Promise<void> {
  const current = await loadPlacement();
  for (const radio of radios) {
    radio.checked = radio.value === current;
    radio.addEventListener("change", () => {
      if (radio.checked) void savePlacement(parsePlacement(radio.value));
    });
  }
}
