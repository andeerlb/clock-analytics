/**
 * Where an open picker box (`.emp-picker-popover`) should go and how tall
 * its list can be. The box normally grows down from its field; when the
 * room below is too small for a usable list (e.g. a field at the very
 * bottom of the page, where an absolutely positioned box can't make the
 * page scroll) and there's more room above, it opens upward instead.
 *
 * "Room" ends at the enclosing scroll area when there is one — a side
 * panel or sheet body — otherwise at the window's edges.
 */
export function fitPickerList({
  root,
  box,
  list,
  footerHeight,
  minListHeight,
  margin,
}: {
  /** The `.emp-picker` wrapper the box is positioned against. */
  root: HTMLElement;
  box: HTMLElement;
  list: HTMLElement;
  footerHeight: number;
  minListHeight: number;
  margin: number;
}): { openUp: boolean; maxHeight: number } {
  const area = root.closest(".side-panel-body, .drawer-body");
  const areaRect = area?.getBoundingClientRect();
  const areaTop = Math.max(0, areaRect?.top ?? 0);
  const areaBottom = Math.min(window.innerHeight, areaRect?.bottom ?? window.innerHeight);
  const rootRect = root.getBoundingClientRect();
  // Height of whatever sits above the list inside the box (search / title row).
  const listOffset = list.getBoundingClientRect().top - box.getBoundingClientRect().top;
  // The box overlaps its field by 2px either way (`top: -2px` / `bottom: -2px`).
  const roomDown = areaBottom - (rootRect.top - 2) - listOffset - footerHeight - margin;
  const roomUp = rootRect.bottom + 2 - areaTop - listOffset - footerHeight - margin;
  const openUp = roomDown < minListHeight && roomUp > roomDown;
  const room = openUp ? roomUp : roomDown;
  return { openUp, maxHeight: Math.max(Math.min(minListHeight, 120), Math.floor(room)) };
}
