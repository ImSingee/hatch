import type { CssRect } from '~components/desktop-host/native-apps';

/**
 * Keeps native App views on their surfaces. One loop measures every tracked
 * surface each frame and reports a change of place, so scrolling, resizing,
 * page zoom, a collapsing sidebar or an animated window all move the view
 * with the page. It also says when one of the page's overlays covers a
 * surface: a native view draws above the whole page, so the surface shows a
 * picture of the App instead until the overlay is gone.
 */
type Tracked = {
  element: HTMLElement;
  place: (rect: CssRect, viewportWidth: number) => void;
  covered: (covered: boolean) => void;
  last: string;
  wasCovered: boolean;
};

const tracked = new Set<Tracked>();
let frame = 0;
// rAF stops while the window is hidden or occluded; the timer keeps places
// current for when it shows again.
let timer: ReturnType<typeof setInterval> | undefined;

/**
 * What the page draws over its content: Mantine's portals (menus, popovers,
 * dialogs, the search palette, tooltips), toasts, and anything marked
 * `data-native-overlay`.
 */
const OVERLAY_ROOTS =
  'body > [data-portal], [data-sonner-toaster] [data-sonner-toast], [data-native-overlay]';

function intersects(a: DOMRect, b: DOMRect) {
  return (
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  );
}

/** Whether a visible box of `root` (a few levels deep) overlaps `rect`. */
function overlaps(root: Element, rect: DOMRect, depth = 0): boolean {
  const box = root.getBoundingClientRect();
  if (box.width > 0 && box.height > 0 && intersects(box, rect)) {
    const style = getComputedStyle(root);
    if (style.visibility !== 'hidden' && style.opacity !== '0') return true;
  }
  if (depth >= 3) return false;
  for (const child of root.children) {
    if (overlaps(child, rect, depth + 1)) return true;
  }
  return false;
}

function overlayOver(rect: DOMRect) {
  for (const root of document.querySelectorAll(OVERLAY_ROOTS)) {
    if (overlaps(root, rect)) return true;
  }
  return false;
}

function measure() {
  for (const item of tracked) {
    const rect = item.element.getBoundingClientRect();
    const key = `${rect.left},${rect.top},${rect.width},${rect.height},${innerWidth}`;
    if (key !== item.last) {
      item.last = key;
      item.place(
        { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        innerWidth,
      );
    }
    const covered = overlayOver(rect);
    if (covered !== item.wasCovered) {
      item.wasCovered = covered;
      item.covered(covered);
    }
  }
}

function loop() {
  measure();
  frame = tracked.size ? requestAnimationFrame(loop) : 0;
}

/** Tracks `element` until the returned function is called. */
export function trackSurface(
  element: HTMLElement,
  callbacks: Pick<Tracked, 'place' | 'covered'>,
): () => void {
  const item: Tracked = { element, ...callbacks, last: '', wasCovered: false };
  tracked.add(item);
  measure();
  if (!frame) frame = requestAnimationFrame(loop);
  timer ??= setInterval(measure, 250);
  return () => {
    tracked.delete(item);
    if (!tracked.size) {
      cancelAnimationFrame(frame);
      frame = 0;
      clearInterval(timer);
      timer = undefined;
    }
  };
}
